import {
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  numeric,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

export const platform = pgEnum('platform', ['instagram', 'whatsapp', 'share_target']);

export const shareStatus = pgEnum('share_status', [
  'queued',
  'resolving',
  'resolved',
  'failed',
]);

/**
 * What the sender actually gave us: a link to scrape, an image upload (media
 * ref lives on the platform), or a plain-text product request.
 */
export const inputKind = pgEnum('input_kind', ['link', 'image', 'text']);

/** How well the reel resolved. Drives which tier of UI the share renders as. */
export const resolution = pgEnum('resolution', ['exact', 'similar', 'none']);

/** What the user can actually do with an item. */
export const itemTier = pgEnum('item_tier', ['buyable', 'deeplink']);

/**
 * A checkout's life: a Prava session opens as 'authorizing', mints credentials
 * on passkey approval, then the executor drives the merchant. 'declined' is a
 * real terminal outcome — the chain ran and the gateway answered — as distinct
 * from 'failed', where the driver never reached one.
 */
export const checkoutStatus = pgEnum('checkout_status', [
  'authorizing',
  'authorized',
  'placed',
  'declined',
  'failed',
]);

/** Where a user's orders ship. Kept whole rather than split into columns because
 *  it is only ever read and written as one unit, straight into a checkout form. */
export interface ShippingAddress {
  firstName: string;
  lastName: string;
  address1: string;
  city: string;
  postalCode: string;
  province?: string;
  countryCode: string;
  phone?: string;
}

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  phone: text('phone').unique(),
  email: text('email'),
  /** Saved on first checkout so nobody types their address twice. */
  shipping: jsonb('shipping').$type<ShippingAddress>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per platform handle. Instagram senders arrive as an IGSID that has no
 * relation to a phone number, so binding it to a user is a one-time link step.
 */
export const identities = pgTable(
  'identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: platform('platform').notNull(),
    externalId: text('external_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('identities_platform_external_id').on(t.platform, t.externalId)],
);

export const shares = pgTable(
  'shares',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: platform('platform').notNull(),
    /**
     * What kind of input produced this share. Rows predating the column are
     * 'link' — accurate, since links were the only accepted intake.
     */
    inputKind: inputKind('input_kind').notNull().default('link'),
    /** Caption, or the sender's own words for text/image shares. */
    inputText: text('input_text'),
    /**
     * Platform-side media handle — a WhatsApp media id or an Instagram CDN
     * url — resolved to bytes by the resolver via the channel adapter.
     */
    mediaRef: text('media_ref'),
    /** '' for image/text shares so shares_dedupe still dedupes per message. */
    sourceUrl: text('source_url').notNull(),
    /** Platform message id. Meta retries webhook deliveries, so this is the idempotency key. */
    messageId: text('message_id'),
    /** Raw webhook payload, kept so the resolver can be re-run without re-fetching. */
    rawPayload: jsonb('raw_payload'),
    /**
     * The frame we identified from, as a data URI. Stored as bytes rather than
     * a URL because Instagram's CDN links are signed and expire within hours —
     * a stored link would leave every older card with a broken image.
     */
    thumbnail: text('thumbnail'),
    status: shareStatus('status').notNull().default('queued'),
    resolution: resolution('resolution'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    index('shares_user_created').on(t.userId, t.createdAt),
    index('shares_status').on(t.status),
    uniqueIndex('shares_dedupe').on(t.platform, t.messageId, t.sourceUrl),
  ],
);

/**
 * A user's OAuth connection to Prava's MCP, one per account.
 *
 * This is what makes the pipeline multi-tenant: purchases run against the
 * connected user's own Prava wallet, cards and addresses, not the app's.
 */
export const pravaConnections = pgTable('prava_connections', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  scope: text('scope'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const items = pgTable(
  'items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shareId: uuid('share_id')
      .notNull()
      .references(() => shares.id, { onDelete: 'cascade' }),
    /** 0 is the best candidate; the dashboard shows rank 0 and keeps the rest for fallback. */
    rank: integer('rank').notNull().default(0),
    tier: itemTier('tier').notNull(),
    title: text('title').notNull(),
    merchant: text('merchant'),
    merchantDomain: text('merchant_domain'),
    priceAmount: numeric('price_amount', { precision: 12, scale: 2 }),
    currency: text('currency'),
    imageUrl: text('image_url'),
    productUrl: text('product_url').notNull(),
    /**
     * Shopify Catalog product/variant GID when the match came from Catalog MCP.
     * Their terms forbid caching search results or images, so this is an
     * identifier for re-querying, not a cache key.
     */
    catalogProductId: text('catalog_product_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('items_share_rank').on(t.shareId, t.rank)],
);

/**
 * One row per Prava session. Without this a session id is unverifiable — any
 * signed-in user could poll or settle someone else's checkout, since Prava is
 * the only party that knows who opened it.
 */
export const checkouts = pgTable(
  'checkouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
    orderId: text('order_id'),
    /** From the minted credentials; Report Status needs it to settle. */
    txnRefId: text('txn_ref_id'),
    status: checkoutStatus('status').notNull().default('authorizing'),
    totalAmount: numeric('total_amount', { precision: 12, scale: 2 }),
    currency: text('currency'),
    /** Merchant verdict, or the driver's reason for never reaching one. */
    outcome: text('outcome'),
    merchantUrl: text('merchant_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('checkouts_session').on(t.sessionId),
    index('checkouts_user_created').on(t.userId, t.createdAt),
  ],
);
