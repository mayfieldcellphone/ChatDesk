import { get, newId, now, run, upsertContact, type Business, type Conversation } from './db';

/**
 * The conversation for a caller or texter: their latest conversation (web chat or phone) so the
 * whole history stays in one thread, or a new phone conversation. Switches it to the phone channel.
 */
export function phoneConversation(business: Business, phone: string | null): Conversation {
  // Callers who hide their number get a fresh conversation each time; there's nothing to match on.
  const existingContact = phone
    ? get<{ id: string }>('SELECT id FROM contacts WHERE business_id = ? AND phone = ?', business.id, phone)
    : undefined;
  const contact = existingContact ?? upsertContact(business.id, phone ?? 'Private number', phone, null);

  const conversation = phone && get<Conversation>(
    'SELECT * FROM conversations WHERE contact_id = ? ORDER BY last_message_at DESC LIMIT 1',
    contact.id,
  );
  if (conversation) {
    if (conversation.channel !== 'sms') {
      run("UPDATE conversations SET channel = 'sms' WHERE id = ?", conversation.id);
      conversation.channel = 'sms';
    }
    return conversation;
  }

  const t = now();
  const created: Conversation = {
    id: newId(), business_id: business.id, contact_id: contact.id, channel: 'sms', status: 'open',
    visitor_token: null, page_url: null, unread_count: 0, last_message_at: t, created_at: t,
  };
  run(
    "INSERT INTO conversations (id, business_id, contact_id, channel, status, last_message_at, created_at) VALUES (?, ?, ?, 'sms', 'open', ?, ?)",
    created.id, business.id, contact.id, t, t,
  );
  return created;
}
