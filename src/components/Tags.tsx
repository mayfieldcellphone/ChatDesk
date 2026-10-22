import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, TAG_COLORS, tagTextColor, type Tag } from '../api';

/** A small coloured label; shows an × when it can be removed. */
export function TagPill({ tag, onRemove }: { tag: Tag; onRemove?: () => void }) {
  const text = tagTextColor(tag.color);
  return (
    <span
      className="inline-flex max-w-[10rem] shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4"
      style={{ background: tag.color, color: text }}
    >
      <span className="truncate">{tag.name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="-mr-0.5 leading-none opacity-80 hover:opacity-100"
          aria-label={`Remove tag ${tag.name}`}
          style={{ color: text }}
        >
          ×
        </button>
      )}
    </span>
  );
}

/** A row of the preset colours; the chosen one is ringed. */
export function ColorChoices({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {TAG_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={`h-6 w-6 rounded-full ${value === c ? 'ring-2 ring-slate-900 ring-offset-2' : ''}`}
          style={{ background: c }}
          aria-label={`Colour ${c}`}
          aria-pressed={value === c}
        />
      ))}
    </div>
  );
}

/** A popover that closes on an outside click or Escape. */
function Popover({ open, onClose, children, align = 'left' }: { open: boolean; onClose: () => void; children: ReactNode; align?: 'left' | 'right' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', click);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', click);
      document.removeEventListener('keydown', key);
    };
  }, [open, onClose]);
  // Keep it on screen on narrow phones. Position it from its button, measured against the visible
  // screen (a menu sticking out widens the page itself, so the window width can't be trusted).
  const [left, setLeft] = useState<number | null>(null);
  useLayoutEffect(() => {
    const anchor = ref.current?.parentElement;
    if (!open || !anchor || !ref.current) return setLeft(null);
    const screen = Math.min(window.visualViewport?.width ?? Infinity, document.documentElement.clientWidth, window.innerWidth);
    const a = anchor.getBoundingClientRect();
    const width = ref.current.offsetWidth;
    const margin = 8;
    const preferred = align === 'right' ? a.width - width : 0;
    const min = margin - a.left;
    const max = screen - margin - width - a.left;
    setLeft(Math.min(Math.max(preferred, min), max));
  }, [open, align]);
  if (!open) return null;
  return (
    <div
      ref={ref}
      style={left === null ? undefined : { left, right: 'auto' }}
      className={`absolute top-full z-30 mt-1 w-64 max-w-[calc(100vw-1rem)] rounded-lg border border-slate-200 bg-white p-2 shadow-lg ${align === 'right' ? 'right-0' : 'left-0'}`}
    >
      {children}
    </div>
  );
}

/**
 * "+ Tag" for a conversation: tick tags on and off, or create a new one (which is added straight away).
 * Reports the conversation's new tags through onChange.
 */
export function TagMenu({ conversationId, current, onChange }: { conversationId: string; current: Tag[]; onChange: (tags: Tag[]) => void }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<Tag[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(TAG_COLORS[0]);
  const [error, setError] = useState('');

  const loadAll = () => api<{ tags: Tag[] }>('/tags').then((d) => setAll(d.tags)).catch((err) => setError(err.message));
  useEffect(() => {
    if (open) loadAll();
    else {
      setCreating(false);
      setError('');
    }
  }, [open]);

  const toggle = async (tag: Tag) => {
    setError('');
    const on = current.some((t) => t.id === tag.id);
    try {
      const d = await api<{ tags: Tag[] }>(`/conversations/${conversationId}/tags/${tag.id}`, { method: on ? 'DELETE' : 'PUT' });
      onChange(d.tags);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const { tag } = await api<{ tag: Tag }>('/tags', { method: 'POST', body: { name, color } });
      const d = await api<{ tags: Tag[] }>(`/conversations/${conversationId}/tags/${tag.id}`, { method: 'PUT' });
      onChange(d.tags);
      setName('');
      setCreating(false);
      loadAll();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-[11px] text-slate-500 hover:border-slate-400 hover:text-slate-700"
      >
        + Tag
      </button>
      <Popover open={open} onClose={() => setOpen(false)}>
        {error && <p className="mb-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700">{error}</p>}
        {!creating ? (
          <>
            <div className="max-h-56 overflow-y-auto">
              {all.length === 0 && <p className="px-2 py-1 text-xs text-slate-400">No tags yet.</p>}
              {all.map((t) => {
                const on = current.some((c) => c.id === t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => toggle(t)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-slate-50"
                  >
                    <span className="w-4 text-center text-blue-600">{on ? '✓' : ''}</span>
                    <TagPill tag={t} />
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="mt-1 w-full rounded border-t border-slate-100 px-2 pt-2 text-left text-sm text-blue-600 hover:underline"
            >
              + Create new tag
            </button>
          </>
        ) : (
          <form onSubmit={create} className="space-y-2">
            <input
              autoFocus
              value={name}
              maxLength={30}
              onChange={(e) => setName(e.target.value)}
              placeholder="Tag name"
              className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
            />
            <ColorChoices value={color} onChange={setColor} />
            {name.trim() && <TagPill tag={{ id: 'preview', name: name.trim(), color }} />}
            <div className="flex gap-2 pt-1">
              <button disabled={!name.trim()} className="rounded-md bg-blue-600 px-3 py-1 text-sm font-semibold text-white disabled:opacity-50">
                Create & add
              </button>
              <button type="button" onClick={() => setCreating(false)} className="text-sm text-slate-500 hover:underline">
                Back
              </button>
            </div>
          </form>
        )}
      </Popover>
    </div>
  );
}

/** Inbox filter: tick one or more tags; conversations must have all of them. */
export function TagFilter({ tags, selected, onChange }: { tags: Tag[]; selected: string[]; onChange: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const active = tags.filter((t) => selected.includes(t.id));
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`h-full whitespace-nowrap rounded-md border px-2.5 py-1.5 text-sm ${active.length ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-300 text-slate-600'}`}
        aria-label="Filter by tag"
      >
        Tags{active.length ? ` (${active.length})` : ''} ▾
      </button>
      <Popover open={open} onClose={() => setOpen(false)} align="right">
        {tags.length === 0 && <p className="px-2 py-1 text-xs text-slate-400">No tags yet. Add them in Settings → Tags.</p>}
        <div className="max-h-64 overflow-y-auto">
          {tags.map((t) => (
            <label key={t.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-slate-50">
              <input
                type="checkbox"
                checked={selected.includes(t.id)}
                onChange={(e) => onChange(e.target.checked ? [...selected, t.id] : selected.filter((id) => id !== t.id))}
              />
              <TagPill tag={t} />
            </label>
          ))}
        </div>
        {tags.length > 0 && (
          <div className="mt-1 flex items-center justify-between border-t border-slate-100 px-2 pt-2 text-xs text-slate-500">
            <span>Shows conversations with all ticked tags</span>
            {selected.length > 0 && (
              <button type="button" onClick={() => onChange([])} className="text-blue-600 hover:underline">
                Clear
              </button>
            )}
          </div>
        )}
      </Popover>
    </div>
  );
}
