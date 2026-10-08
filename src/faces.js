// Only a face-presence boolean is kept in memory. Photos never leave this browser.
const assets = new URL('../vendor/face-api/', import.meta.url);
let ready;
function prepare() {
  if (ready) return ready;
  let script, timeout;
  const setup = new Promise((resolve, reject) => {
    if (globalThis.faceapi) { resolve(); return; }
    script = document.createElement('script');
    script.src = new URL('face-api.min.js', assets).href;
    script.onload = resolve;
    script.onerror = () => { script.remove(); reject(new Error('顔判定を読み込めません。通信を確認して再読み込みしてください。')); };
    document.head.append(script);
  }).then(async () => {
    await globalThis.faceapi.tf.setBackend('cpu');
    if (!globalThis.faceapi.nets.tinyFaceDetector.isLoaded) await globalThis.faceapi.nets.tinyFaceDetector.loadFromUri(assets.href);
  });
  ready = Promise.race([setup, new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error('顔判定の準備がタイムアウトしました。通信を確認して再読み込みしてください。')), 20000);
  })]).catch(error => { ready = null; throw Object.assign(error, {code:'FACE'}); })
    .finally(() => { clearTimeout(timeout); script?.remove(); });
  return ready;
}

export class FaceFilter {
  constructor() { this.results = new Map(); this.queue = Promise.resolve(); this.generation = 0; }
  clear() { this.generation++; this.results.clear(); }
  check(image, id, signal) {
    const generation = this.generation;
    const job = this.queue.then(async () => {
      signal?.throwIfAborted();
      if (generation !== this.generation) throw new DOMException('Source changed', 'AbortError');
      if (this.results.has(id)) return this.results.get(id);
      await prepare(); signal?.throwIfAborted();
      // Avoid a full-resolution copy of a large iPad/Drive photo inside face-api.
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      try {
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        const api = globalThis.faceapi;
        const detection = await api.detectSingleFace(canvas, new api.TinyFaceDetectorOptions({inputSize:512,scoreThreshold:0.5}));
        signal?.throwIfAborted();
        if (generation !== this.generation) throw new DOMException('Source changed', 'AbortError');
        if (this.results.size >= 4096) this.results.delete(this.results.keys().next().value);
        this.results.set(id, Boolean(detection));
        return Boolean(detection);
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        throw Object.assign(new Error('顔の判定に失敗しました。再読み込みで再試行してください。'), {code:'FACE',cause:error});
      } finally { canvas.width = canvas.height = 1; }
    });
    // Yield between inferences so settings and Stop remain responsive on tablets.
    this.queue = job.catch(() => {}).then(() => new Promise(resolve => setTimeout(resolve, 0)));
    return job;
  }
}
export const faceFilter = new FaceFilter();
