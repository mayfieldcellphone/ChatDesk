import nodemailer, { type Transporter } from 'nodemailer';
import { all, get, now, run, type Business, type Contact, type Conversation, type Message, type Review } from './db';
import { subscriberCount } from './events';
import { config, onConfigChange } from './config';

const ALERT_REPEAT_MS = 15 * 60 * 1000;

export const emailConfigured = () => Boolean(config('SMTP_HOST') && config('SMTP_FROM'));

const alertRecipients = (businessId: string) =>
  all<{ email: string }>(
    'SELECT u.email FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.business_id = ? AND u.notify_email = 1',
    businessId,
  );

let transport: Transporter | null | undefined;
// Email settings can be changed on the Integrations page; reconnect with the new ones.
onConfigChange(() => {
  transport = undefined;
});
function getTransport() {
  if (transport === undefined) {
    const port = Number(config('SMTP_PORT')) || 587;
    transport = emailConfigured()
      ? nodemailer.createTransport({
          host: config('SMTP_HOST'),
          port,
          secure: port === 465,
          auth: config('SMTP_USER') ? { user: config('SMTP_USER'), pass: config('SMTP_PASS') } : undefined,
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
  const link = process.env.PUBLIC_URL ? `\n\nOpen ChatBird: ${process.env.PUBLIC_URL.replace(/\/$/, '')}` : '';
  const { subject, intro } =
    message.kind === 'voicemail'
      ? { subject: `New voicemail from ${name}`, intro: `${who} left a voicemail for ${business.name}. Transcript:` }
      : message.kind === 'call'
        ? { subject: `Missed call from ${name}`, intro: `${who} called ${business.name} and hung up without leaving a voicemail.` }
        : message.kind === 'quote'
          ? { subject: `Quote request from ${name}`, intro: `${who} asked ${business.name} for a quote on the website:` }
          : message.kind === 'callback'
            ? { subject: `Call back ${name}`, intro: `${who} asked ${business.name} to call them back:` }
            : message.kind === 'booking'
            ? { subject: `New booking from ${name}`, intro: `${who} booked a repair with ${business.name} on the website:` }
            : message.kind === 'enquiry'
            ? { subject: `Website enquiry from ${name}`, intro: `${who} sent ${business.name} a form on the website:` }
            : { subject: `New ${message.channel === 'sms' ? 'text' : 'web chat'} message from ${name}`, intro: `${who} wrote to ${business.name}:` };
  const body = message.kind === 'call' ? '' : `\n\n${message.body}`;

  await mailer.sendMail({
    from: config('SMTP_FROM'),
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
  const link = process.env.PUBLIC_URL ? `\n\nReply in ChatBird: ${process.env.PUBLIC_URL.replace(/\/$/, '')}/?view=reviews` : '';

  await mailer.sendMail({
    from: config('SMTP_FROM'),
    to: recipients.map((r) => r.email),
    subject,
    text: `${business.name} has new reviews on Google:\n\n${lines.join('\n\n')}${link}\n\nTurn these emails off in Settings.`,
  });
}

/** Sends the weekly summary (reports.ts) to everyone on the business. Returns false when email isn't set up. */
export async function emailWeeklyReport(business: Business, subject: string, text: string) {
  const mailer = getTransport();
  const recipients = all<{ email: string }>('SELECT u.email FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.business_id = ?', business.id);
  if (!mailer || recipients.length === 0) return false;
  await mailer.sendMail({ from: config('SMTP_FROM'), to: recipients.map((r) => r.email), subject, text });
  return true;
}

/** One marketing email (campaigns.ts), in the business's name, with an unsubscribe link and one-click header. */
export async function emailCampaign(business: Business, to: string, subject: string, body: string, unsubscribe: string) {
  const mailer = getTransport();
  if (!mailer) throw new Error('Email is not set up on the server');
  const from = config('SMTP_FROM')!;
  const address = from.match(/<([^>]+)>/)?.[1] ?? from.trim();
  const name = business.name.replace(/[\r\n"]+/g, ' ');
  const replyTo = replyAddress(business);
  await mailer.sendMail({
    from: { name, address },
    to,
    ...(replyTo ? { replyTo: { name, address: replyTo } } : {}),
    subject: subject.replace(/[\r\n]+/g, ' '),
    text: `${body}\n\n— ${business.name}\n\nDon't want these emails? Unsubscribe: ${unsubscribe}`,
    headers: { 'List-Unsubscribe': `<${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  });
}

/** The address customers' answers go to: the business's reply address, or the owner's login email. */
export function replyAddress(business: Business) {
  if (business.reply_email) return business.reply_email;
  const owner = get<{ email: string }>(
    'SELECT u.email FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.business_id = ? ORDER BY m.created_at LIMIT 1',
    business.id,
  );
  return owner?.email ?? null;
}

/** Emails a reply from the inbox to a customer, sent in the business's name. */
export async function emailCustomer(business: Business, contact: Contact, body: string) {
  const mailer = getTransport();
  if (!mailer || !contact.email) throw new Error('Email is not set up on the server');
  const from = config('SMTP_FROM')!;
  const address = from.match(/<([^>]+)>/)?.[1] ?? from.trim();
  const replyTo = replyAddress(business);
  await mailer.sendMail({
    from: { name: business.name.replace(/[\r\n"]+/g, ' '), address },
    to: contact.email,
    ...(replyTo ? { replyTo: { name: business.name.replace(/[\r\n"]+/g, ' '), address: replyTo } } : {}),
    subject: `Message from ${business.name}`.replace(/[\r\n]+/g, ' '),
    text: `${body}\n\n— ${business.name}${replyTo ? '\n\nReply to this email to get back to us.' : ''}`,
  });
}
