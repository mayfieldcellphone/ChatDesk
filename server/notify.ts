import nodemailer, { type Transporter } from 'nodemailer';
import { all, get, now, run, type Business, type Conversation, type Message } from './db';
import { subscriberCount } from './events';

const ALERT_REPEAT_MS = 15 * 60 * 1000;

export const emailConfigured = () => Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);

let transport: Transporter | null | undefined;
function getTransport() {
  if (transport === undefined) {
    const port = Number(process.env.SMTP_PORT) || 587;
    transport = emailConfigured()
      ? nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port,
          secure: port === 465,
          auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
        })
      : null;
  }
  return transport;
}

/**
 * Emails the team about a customer message when nobody has the inbox open.
 * At most one email per conversation every 15 minutes, so a burst of messages sends one alert.
 */
export async function emailTeam(business: Business, conversation: Conversation, message: Message) {
  const mailer = getTransport();
  if (!mailer || subscriberCount(`biz:${business.id}`) > 0) return;

  const fresh = get<{ last_email_alert_at: string | null }>('SELECT last_email_alert_at FROM conversations WHERE id = ?', conversation.id);
  if (fresh?.last_email_alert_at && Date.now() - Date.parse(fresh.last_email_alert_at) < ALERT_REPEAT_MS) return;

  const recipients = all<{ email: string }>('SELECT email FROM users WHERE business_id = ? AND notify_email = 1', business.id);
  if (recipients.length === 0) return;
  run('UPDATE conversations SET last_email_alert_at = ? WHERE id = ?', now(), conversation.id);

  const contact = get<{ name: string; phone: string | null }>('SELECT name, phone FROM contacts WHERE id = ?', conversation.contact_id);
  const name = (contact?.name ?? 'A customer').replace(/[\r\n]+/g, ' ');
  const via = message.channel === 'sms' ? 'text' : 'web chat';
  const link = process.env.PUBLIC_URL ? `\n\nReply in ChatDesk: ${process.env.PUBLIC_URL.replace(/\/$/, '')}` : '';

  await mailer.sendMail({
    from: process.env.SMTP_FROM,
    to: recipients.map((r) => r.email),
    subject: `New ${via} message from ${name}`,
    text: `${name}${contact?.phone ? ` (${contact.phone})` : ''} wrote to ${business.name}:\n\n${message.body}${link}\n\nYou're getting this because nobody had the inbox open. Turn these emails off in Settings.`,
  });
}
