import { useState } from 'react';
import { usePush } from '../push';

/** Turn phone/desktop notifications on for this device, with install help for iPhone. */
export default function PushControls() {
  const { state, error, enable, disable, test, ios } = usePush();
  const [tested, setTested] = useState(false);

  if (state === 'loading') return null;
  return (
    <div className="space-y-2 rounded-md bg-slate-50 p-3 text-sm">
      <div className="font-medium">Notifications on this device</div>
      {state === 'needs-install' && (
        <p className="text-slate-600">
          On iPhone, first add ChatBird to your Home Screen: tap <b>Share</b> <span aria-hidden>⬆️</span> in Safari, then <b>Add to Home Screen</b>. Open ChatBird from
          the new icon and come back here to turn notifications on.
        </p>
      )}
      {state === 'unsupported' && <p className="text-slate-600">This browser can’t show notifications. Try Chrome, Edge, Firefox or Safari.</p>}
      {state === 'blocked' && (
        <p className="text-slate-600">
          Notifications are blocked for ChatBird. Allow them in your {ios ? 'iPhone Settings → Notifications → ChatBird' : 'browser’s site settings'}, then reload.
        </p>
      )}
      {state === 'off' && (
        <>
          <p className="text-slate-600">Get a notification for every new message, call, voicemail and review, from all your businesses, even when ChatBird is closed.</p>
          <button onClick={enable} className="rounded-md bg-blue-600 px-3 py-1.5 font-semibold text-white hover:bg-blue-700">
            🔔 Turn on notifications
          </button>
        </>
      )}
      {state === 'on' && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-green-700">✓ On for this device</span>
          <button
            onClick={async () => {
              await test();
              setTested(true);
            }}
            className="text-blue-600 hover:underline"
          >
            Send a test
          </button>
          <button onClick={disable} className="text-slate-500 hover:underline">
            Turn off
          </button>
          {tested && <span className="text-xs text-slate-500">Sent. Lock your phone or switch apps to see it.</span>}
        </div>
      )}
      {error && <p className="text-red-600">{error}</p>}
    </div>
  );
}
