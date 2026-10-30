import { get, run, type Business, type Connection, type Review } from './db';
import { aiConfigured, suggestReviewReply } from './ai';
import { replyToReview } from './google';
import { publish } from './events';
import { pushToBusiness } from './push';

/**
 * Automatic replies to new Google reviews. Modes per business:
 * - draft: the AI writes a reply and saves it for the owner to approve on the Reviews page.
 * - positive: 4 and 5 star reviews are answered straight away; 1 to 3 stars get a draft to approve.
 * - all: every new review is answered straight away.
 * Only reviews left after the mode was switched on are considered, and a review that already has a
 * reply (from anyone, any tool) is never replied to, edited or deleted.
 */

const MAX_AUTO_PER_DAY = Number(process.env.REVIEW_AUTO_REPLIES_PER_DAY) || 20;

const postsAutomatically = (mode: Business['review_reply_mode'], rating: number) => mode === 'all' || (mode === 'positive' && rating >= 4);

/** Called by the review sync with the reviews it just found. */
export async function handleNewReviews(business: Business, reviews: Review[]) {
  if (business.review_reply_mode === 'off' || !business.review_reply_since || !aiConfigured()) return;
  for (const review of reviews) {
    try {
      await handleReview(business, review);
    } catch (err) {
      console.error(`Review reply for ${business.name} failed:`, (err as Error).message);
      run('UPDATE reviews SET reply_error = ? WHERE id = ?', (err as Error).message.slice(0, 300), review.id);
    }
  }
  publish(`biz:${business.id}`, { type: 'review', count: 0 });
}

async function handleReview(business: Business, review: Review) {
  if (review.reply || review.ai_draft || review.review_created_at < business.review_reply_since!) return;
  const location = get<Connection>('SELECT * FROM connections WHERE id = ?', review.connection_id)?.name ?? '';
  const automatic = postsAutomatically(business.review_reply_mode, review.rating);
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const today = get<{ n: number }>('SELECT COUNT(*) AS n FROM reviews WHERE business_id = ? AND auto_replied = 1 AND reply_updated_at > ?', business.id, dayAgo)!.n;
  const post = automatic && today < MAX_AUTO_PER_DAY;

  const text = (await suggestReviewReply(business, review, { location, automatic: post })).trim().slice(0, 4000);
  if (!text) return;
  // Check again right before posting: someone may have replied in the meantime (by hand or another tool).
  const fresh = get<Review>('SELECT * FROM reviews WHERE id = ?', review.id);
  if (!fresh || fresh.reply) return;

  if (post) {
    await replyToReview(fresh, text);
    run('UPDATE reviews SET auto_replied = 1, ai_draft = NULL, reply_error = NULL WHERE id = ?', review.id);
    return;
  }
  run('UPDATE reviews SET ai_draft = ?, reply_error = NULL WHERE id = ?', text, review.id);
  pushToBusiness(business.id, {
    title: `Reply ready to approve · ${location || business.name}`,
    body: `${review.rating}★ ${review.author_name}: ${review.comment || '(rating only)'}`.slice(0, 200),
    url: `/?business=${business.id}&view=reviews`,
    tag: `review-draft-${review.id}`,
  }).catch((err) => console.error('Push failed:', err));
}
