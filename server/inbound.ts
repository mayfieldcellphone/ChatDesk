import { get, now, run, type Business, type Contact, type Conversation, type Message } from './db';
import { publish } from './events';
import { isOpen } from './hours';
import { emailTeam } from './notify';
import { replyChannels, sendToCustomer } from './outbound';

const AWAY_REPEAT_MS = 12 * 60 * 60 * 1000;

/**
 * Everything that happens when a customer message arrives, whichever channel it came in on.
 * Voicemails skip the away message: the caller already heard the voicemail greeting.
 */
export function onInboundMessage(business: Business, conversation: Conversation, message: Message, { awayMessage = true } = {}) {
  publish(`biz:${business.id}`, { type: 'message', conversationId: conversation.id, message: { ...message, author_name: null } });
  if (awayMessage) sendAwayMessageIfClosed(business, conversation).catch((err) => console.error('Away message failed:', err));
  emailTeam(business, conversation, message).catch((err) => console.error('Email alert failed:', err));
}

/** Outside office hours, replies once per conversation (at most every 12 hours) with the away message. */
async function sendAwayMessageIfClosed(business: Business, conversation: Conversation) {
  if (isOpen(business)) return;
  const fresh = get<Conversation & { last_auto_reply_at: string | null }>('SELECT * FROM conversations WHERE id = ?', conversation.id);
  if (!fresh) return;
  if (fresh.last_auto_reply_at && Date.now() - Date.parse(fresh.last_auto_reply_at) < AWAY_REPEAT_MS) return;

  // Reply on the channel the customer just used.
  const contact = get<Contact>('SELECT * FROM contacts WHERE id = ?', fresh.contact_id)!;
  if (!replyChannels(business, fresh, contact).includes(fresh.channel)) return;
  // Claim the slot before the network call so a burst of messages doesn't send several away messages.
  run('UPDATE conversations SET last_auto_reply_at = ? WHERE id = ?', now(), fresh.id);
  await sendToCustomer(business, fresh, fresh.channel, business.away_message, { automated: true });
}
