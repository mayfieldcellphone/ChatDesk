// Sound and desktop notifications for new customer messages while the inbox is open.

let audio: AudioContext | undefined;

/** A short two-note chime, generated so there's no sound file to ship. */
export function playChime() {
  try {
    audio ??= new AudioContext();
    void audio.resume();
    const start = audio.currentTime;
    [880, 1320].forEach((freq, i) => {
      const t = start + i * 0.12;
      const osc = audio!.createOscillator();
      const gain = audio!.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      osc.connect(gain).connect(audio!.destination);
      osc.start(t);
      osc.stop(t + 0.32);
    });
  } catch {
    // Audio unavailable (e.g. blocked until the page is clicked); the badge and title still update.
  }
}

export const desktopAlertsSupported = () => typeof window !== 'undefined' && 'Notification' in window;

export function showDesktopAlert(title: string, body: string, onClick: () => void) {
  if (!desktopAlertsSupported() || Notification.permission !== 'granted') return;
  const n = new Notification(title, { body: body.slice(0, 140), tag: 'chatdesk-message' });
  n.onclick = () => {
    window.focus();
    onClick();
    n.close();
  };
}
