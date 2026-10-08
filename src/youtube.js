import { randomSeek } from './core.js?v=20261008-media10';
let apiPromise;
function youtubeAPI() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!apiPromise) apiPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api';
    const timeout = setTimeout(() => reject(new Error('YouTubeに接続できません。')), 20000);
    window.onYouTubeIframeAPIReady = () => { clearTimeout(timeout); resolve(window.YT); };
    script.onerror = () => { clearTimeout(timeout); reject(new Error('YouTubeの読み込みに失敗しました。')); };
    document.head.append(script);
  }).catch(error => { apiPromise = null; throw error; });
  return apiPromise;
}

export class VideoPlayer {
  constructor({ onError, onBlocked, onAudible }) { this.onError = onError; this.onBlocked = onBlocked; this.onAudible = onAudible; this.player = null; this.alive = true; this.running = false; this.previous = -100; this.pendingSeek = true; }
  async mount(host, item, settings) {
    this.item = item; this.settings = settings;
    const YT = await youtubeAPI();
    if (!this.alive) return;
    this.player = new YT.Player(host, {
      videoId: item.videoId,
      playerVars: { playsinline: 1, autoplay: 0, controls: 1, origin: location.origin, rel: 0 },
      events: {
        onReady: () => { if (!this.alive) return; this.ready = true; this.applySound(); if (this.running) this.play(); },
        onStateChange: event => {
          if (!this.alive) return;
          this.onAudible(event.data === YT.PlayerState.PLAYING && this.settings.sound && this.settings.volume > 0);
          if (event.data === YT.PlayerState.PLAYING && !this.running) { this.player.pauseVideo(); return; }
          if (this.running && event.data === YT.PlayerState.PLAYING && this.pendingSeek) this.initialSeek();
          if (this.running && event.data === YT.PlayerState.ENDED) { this.seek(); this.player.playVideo(); }
        },
        onError: () => { if (this.alive) this.onError(); },
        onAutoplayBlocked: () => { if (this.alive) { this.onAudible(false); this.onBlocked(); } }
      }
    });
  }
  applySound() {
    if (!this.ready) return;
    this.settings.sound ? this.player.unMute() : this.player.mute();
    this.player.setVolume(this.settings.volume);
  }
  play() { this.running = true; if (this.ready) { this.applySound(); if (this.pendingSeek) this.initialSeek(); this.player.playVideo(); } }
  pause() { this.running = false; clearTimeout(this.seekTimer); this.onAudible(false); if (this.ready) this.player.pauseVideo(); }
  initialSeek(attempt = 0) {
    clearTimeout(this.seekTimer);
    if (!this.alive || !this.running || !this.pendingSeek) return;
    if (!this.seek() && attempt < 100) this.seekTimer = setTimeout(() => this.initialSeek(attempt + 1), 200);
  }
  seek() {
    if (!this.ready) return false;
    const point = randomSeek(this.player.getDuration(), this.settings.refresh, this.previous);
    if (point === null) { this.pendingSeek = true; return false; }
    this.previous = point; this.pendingSeek = false; this.player.seekTo(point, true); return true;
  }
  destroy() { this.alive = false; this.running = false; clearTimeout(this.seekTimer); this.onAudible(false); this.player?.destroy(); this.player = null; }
}
