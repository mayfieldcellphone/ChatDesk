import nodemailer, { type Transporter } from 'nodemailer';
import { all, get, now, run, type Business, type Conversation, type Message, type Review } from './db';
import { subscriberCount } from './events';

const ALERT_REPEAT_MS = 15 * 60 * 1000;

export const emailConfigured = () => Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);

const alertRecipients = (businessId: string) =>
  all<{ email: string }>(
    'SELECT u.email FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.business_id = ? AND u.notify_email = 1',
    businessId,
  );

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

  const recipients = alertRecipients(business.id);
  if (recipients.length === 0) return;
  run('UPDATE conversations SET last_email_alert_at = ? WHERE id = ?', now(), conversation.id);

  const contact = get<{ name: string; phone: string | null }>('SELECT name, phone FROM contacts WHERE id = ?', conversation.contact_id);
  const name = (contact?.name ?? 'A customer').replace(/[\r\n]+/g, ' ');
  const who = `${name}${contact?.phone ? ` (${contact.phone})` : ''}`;
  const link = process.env.PUBLIC_URL ? `\n\nOpen ChatDesk: ${process.env.PUBLIC_URL.replace(/\/$/, '')}` : '';
  const { subject, intro } =
    message.kind === 'voicemail'
      ? { subject: `New voicemail from ${name}`, intro: `${who} left a voicemail for ${business.name}. Transcript:` }
      : message.kind === 'call'
        ? { subject: `Missed call from ${name}`, intro: `${who} called ${business.name} and hung up without leaving a voicemail.` }
        : { subject: `New ${message.channel === 'sms' ? 'text' : 'web chat'} message from ${name}`, intro: `${who} wrote to ${business.name}:` };
  const body = message.kind === 'call' ? '' : `\n\n${message.body}`;

  await mailer.sendMail({
    from: process.env.SMTP_FROM,
    to: recipients.map((r) => r.email),
    subject,
    text: `${intro}${body}${link}\n\nYou're getting this because nobody had the inbox open. Turn these emails off in Settings.`,
  });
}

/** Emails everyone who wants alerts about new Google reviews. Low ratings are called out in the subject. */
export async function emailReviewAlert(business: Business, reviews: Review[]) {
  const mailer = getTransport();
  if (!mailer || reviews.length === 0) return;
  const recipients = alertRecipients(business.id);
  if (recipients.length === 0) return;

  const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n);
  const low = reviews.some((r) => r.rating > 0 && r.rating <= 3);
  const subject =
    reviews.length === 1
      ? `${low ? 'Needs attention: ' : ''}New ${reviews[0].rating}-star Google review from ${reviews[0].author_name.replace(/[\r\n]+/g, ' ')}`
      : `${reviews.length} new Google reviews${low ? ' (including a low rating)' : ''}`;
  const lines = reviews.map((r) => `${stars(r.rating)}  ${r.author_name}\n${r.comment || '(no comment, rating only)'}`);
  const link = process.env.PUBLIC_URL ? `\n\nReply in ChatDesk: ${process.env.PUBLIC_URL.replace(/\/$/, '')}/?view=reviews` : '';

  await mailer.sendMail({
    from: process.env.SMTP_FROM,
    to: recipients.map((r) => r.email),
    subject,
    text: `${business.name} has new reviews on Google:\n\n${lines.join('\n\n')}${link}\n\nTurn these emails off in Settings.`,
  });
}
