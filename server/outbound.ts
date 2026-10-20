import { get, insertMessage, type Business, type Channel, type Connection, type Contact, type Conversation, type Message, type MessageOptions } from './db';
import { isVisitorOnline, publish } from './events';
import { metaConfigured, sendMetaMessage } from './meta';
import { sendSms, smsConfigured } from './twilio';

export class DeliveryError extends Error {}

const CHANNEL_NAMES: Record<Channel, string> = { webchat: 'web chat', sms: 'text', facebook: 'Messenger', instagram: 'Instagram' };

/** The ways staff can reach this customer right now, best first. */
export function replyChannels(business: Business, conversation: Conversation, contact: Contact): Channel[] {
  const channels: Channel[] = [];
  const connection = conversation.connection_id
    ? get<Connection>('SELECT * FROM connections WHERE id = ? AND business_id = ?', conversation.connection_id, business.id)
    : undefined;
  if (connection?.provider === 'facebook' && contact.facebook_id && metaConfigured()) channels.push('facebook');
  if (connection?.provider === 'instagram' && contact.instagram_id && metaConfigured()) channels.push('instagram');
  if (conversation.visitor_token) channels.push('webchat');
  if (smsConfigured() && business.sms_number && contact.phone) channels.push('sms');
  return channels;
}

/** The channel to use when nothing is chosen: the one the customer is on now, or the one they used. */
export function defaultChannel(business: Business, conversation: Conversation, contact: Contact): Channel | null {
  const channels = replyChannels(business, conversation, contact);
  if (conversation.channel === 'webchat' && channels.includes('webchat') && (isVisitorOnline(conversation.id) || !channels.includes('sms'))) return 'webchat';
  if (channels.includes(conversation.channel)) return conversation.channel;
  return channels[0] ?? null;
}

/**
 * Sends a message to the customer over the given channel, records it in the conversation and pushes
 * it live to the inbox (and the visitor's widget). Throws DeliveryError if it can't be delivered.
 */
export async function sendToCustomer(
  business: Business,
  conversation: Conversation,
  channel: Channel,
  body: string,
  options: MessageOptions & { authorName?: string | null } = {},
): Promise<Message & { author_name: string | null }> {
  const contact = get<Contact>('SELECT * FROM contacts WHERE id = ?', conversation.contact_id)!;
  if (!replyChannels(business, conversation, contact).includes(channel)) {
    throw new DeliveryError(
      channel === 'sms' && !(smsConfigured() && business.sms_number)
        ? 'Texting is not set up. Add your Twilio number in Settings.'
        : `This customer can’t be reached by ${CHANNEL_NAMES[channel]}.`,
    );
  }

  let externalId: string | null = null;
  try {
    if (channel === 'sms') {
      await sendSms(business.sms_number!, contact.phone!, body);
    } else if (channel === 'facebook' || channel === 'instagram') {
      const connection = get<Connection>('SELECT * FROM connections WHERE id = ?', conversation.connection_id!)!;
      externalId = await sendMetaMessage(connection, (channel === 'facebook' ? contact.facebook_id : contact.instagram_id)!, body);
    }
  } catch (err) {
    throw new DeliveryError(`${CHANNEL_NAMES[channel][0].toUpperCase()}${CHANNEL_NAMES[channel].slice(1)} not sent: ${(err as Error).message}`);
  }

  const { authorName = null, ...messageOptions } = options;
  const message = insertMessage(conversation, 'out', channel, body, { ...messageOptions, externalId });
  const full = { ...message, author_name: authorName };
  publish(`biz:${business.id}`, { type: 'message', conversationId: conversation.id, message: full });
  publish(`conv:${conversation.id}`, {
    type: 'message',
    message: { id: message.id, direction: 'out', body: message.body, created_at: message.created_at },
  });
  return full;
}
