/** The ChatBird mark: a superb fairy-wren in a chat bubble. Same drawing as public/icons/icon.svg. */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true" className="shrink-0">
      <rect width="48" height="48" rx="11" fill="#087565" />
      <path d="M11 7h26a5 5 0 0 1 5 5v19a5 5 0 0 1-5 5H19l-7.5 6v-6H11a5 5 0 0 1-5-5V12a5 5 0 0 1 5-5z" fill="#fff" />
      <path d="M15.5 22.5 10.2 12.6c-.4-.8.4-1.5 1.1-1l8.4 7.6z" fill="#087565" />
      <ellipse cx="24" cy="24" rx="7.6" ry="6.2" fill="#087565" />
      <circle cx="29.6" cy="17.4" r="4.4" fill="#087565" />
      <path d="M33.6 16.2 37.4 17.6 33.6 19z" fill="#F2A33A" />
      <circle cx="30.6" cy="16.6" r="1.05" fill="#fff" />
      <path d="M18.2 22.6c3-3.4 8.4-3.6 11.4-.2-3.6 2.2-7.8 2.4-11.4.2z" fill="#6FC4B4" />
      <path d="M22.6 30v3.2M26 30v3.2" stroke="#087565" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** "ChatBird" with "Bird" in brand teal (lighter on dark backgrounds). */
export function Wordmark({ dark = false, className = '' }: { dark?: boolean; className?: string }) {
  return (
    <span className={`font-extrabold tracking-tight ${dark ? 'text-white' : 'text-slate-900'} ${className}`}>
      Chat<span className={dark ? 'text-blue-300' : 'text-blue-600'}>Bird</span>
    </span>
  );
}
