export const VOICE_SAMPLE_RATE = 16_000;
const FRAME_SECONDS = 0.04;

export function resampleMono(
	samples: Float32Array,
	sourceRate: number,
	targetRate = VOICE_SAMPLE_RATE,
): Float32Array {
	if (sourceRate === targetRate) return samples;
	const output = new Float32Array(
		Math.max(1, Math.round((samples.length * targetRate) / sourceRate)),
	);
	const ratio = sourceRate / targetRate;
	for (let index = 0; index < output.length; index += 1) {
		const position = index * ratio;
		const left = Math.floor(position);
		const right = Math.min(left + 1, samples.length - 1);
		output[index] =
			samples[left] * (1 - (position - left)) +
			samples[right] * (position - left);
	}
	return output;
}

export function encodePcm16Base64(samples: Float32Array): string {
	const bytes = new Uint8Array(samples.length * 2);
	for (let index = 0; index < samples.length; index += 1) {
		const value = Math.max(-1, Math.min(1, samples[index]));
		const integer =
			value < 0 ? Math.round(value * 32_768) : Math.round(value * 32_767);
		bytes[index * 2] = integer & 0xff;
		bytes[index * 2 + 1] = (integer >> 8) & 0xff;
	}
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function decodePcm16Base64(encoded: string): Float32Array {
	const binary = atob(encoded);
	const samples = new Float32Array(binary.length / 2);
	for (let index = 0; index < samples.length; index += 1) {
		const value =
			binary.charCodeAt(index * 2) | (binary.charCodeAt(index * 2 + 1) << 8);
		samples[index] = (value & 0x8000 ? value - 0x10000 : value) / 32_768;
	}
	return samples;
}

export class MicrophoneCapture {
	#context?: AudioContext;
	#stream?: MediaStream;
	#source?: MediaStreamAudioSourceNode;
	#worklet?: AudioWorkletNode;

	async start(onFrame: (pcm_b16: string) => void): Promise<void> {
		if (this.#context) return;
		this.#stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				channelCount: 1,
				echoCancellation: true,
				noiseSuppression: true,
			},
		});
		const context = new AudioContext();
		const source = context.createMediaStreamSource(this.#stream);
		const code = `class FrameCapture extends AudioWorkletProcessor {
      constructor() { super(); this.samples = []; this.limit = Math.round(sampleRate * ${FRAME_SECONDS}); }
      process(inputs) { const input = inputs[0]?.[0]; if (!input) return true; this.samples.push(...input); if (this.samples.length >= this.limit) { const frame = new Float32Array(this.samples.splice(0, this.limit)); this.port.postMessage(frame, [frame.buffer]); } return true; }
    } registerProcessor("study-sidecar-frame-capture", FrameCapture);`;
		const url = URL.createObjectURL(
			new Blob([code], { type: "application/javascript" }),
		);
		try {
			await context.audioWorklet.addModule(url);
		} finally {
			URL.revokeObjectURL(url);
		}
		const worklet = new AudioWorkletNode(
			context,
			"study-sidecar-frame-capture",
		);
		worklet.port.onmessage = ({ data }: MessageEvent<Float32Array>) =>
			onFrame(encodePcm16Base64(resampleMono(data, context.sampleRate)));
		source.connect(worklet);
		worklet.connect(context.destination);
		await context.resume();
		this.#context = context;
		this.#source = source;
		this.#worklet = worklet;
	}

	async stop(): Promise<void> {
		this.#source?.disconnect();
		this.#worklet?.disconnect();
		this.#stream?.getTracks().forEach((track) => {
			track.stop();
		});
		await this.#context?.close();
		this.#context = undefined;
		this.#stream = undefined;
		this.#source = undefined;
		this.#worklet = undefined;
	}
}

export class PcmPlayback {
	#context?: AudioContext;
	#sources: AudioBufferSourceNode[] = [];
	#nextStart = 0;
	#onActiveChange?: (active: boolean) => void;

	constructor(onActiveChange?: (active: boolean) => void) {
		this.#onActiveChange = onActiveChange;
	}

	get active(): boolean {
		return this.#sources.length > 0;
	}

	async enqueue(encoded: string): Promise<void> {
		const context = this.#context ?? new AudioContext();
		this.#context = context;
		await context.resume();
		const samples = decodePcm16Base64(encoded);
		const buffer = context.createBuffer(1, samples.length, VOICE_SAMPLE_RATE);
		buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
		const source = context.createBufferSource();
		source.buffer = buffer;
		source.connect(context.destination);
		const start = Math.max(context.currentTime + 0.02, this.#nextStart);
		this.#nextStart = start + buffer.duration;
		source.onended = () => {
			this.#sources = this.#sources.filter((current) => current !== source);
			if (!this.#sources.length) this.#onActiveChange?.(false);
		};
		const wasInactive = !this.#sources.length;
		this.#sources.push(source);
		source.start(start);
		if (wasInactive) this.#onActiveChange?.(true);
	}

	stop(): void {
		for (const source of this.#sources) source.stop();
		this.#sources = [];
		this.#nextStart = 0;
		this.#onActiveChange?.(false);
	}
}
