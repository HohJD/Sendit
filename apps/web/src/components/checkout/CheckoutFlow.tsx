import { useCallback, useEffect, useRef, useState } from 'react';

const steps = (merchant: string) =>
  [
    { active: 'Opening a Prava session', done: 'Session opened' },
    { active: 'Waiting for your passkey', done: 'Passkey approved' },
    { active: 'Minting the one-time card', done: 'One-time card minted' },
    { active: `Buying at ${merchant}`, done: `Bought at ${merchant}` },
    { active: 'Reporting the outcome', done: 'Reported to Prava' },
  ] as const;

export interface Credentials {
  token: string;
  dynamicCvv: string;
  expiryMonth: string | number;
  expiryYear: string | number;
  txnRefId: string;
}

export interface Shipping {
  firstName: string;
  lastName: string;
  address1: string;
  city: string;
  postalCode: string;
  province?: string;
  countryCode: string;
  phone?: string;
}

export interface CheckoutFlowProps {
  /** Demo: skip the Prava tab and run the agent with the sandbox test card on buy. */
  fallbackDirect?: boolean;
  sessionId: string;
  checkoutUrl: string;
  expiresAt: string;
  orderId: string;
  itemId: string;
  title: string;
  merchant: string | null;
  imageUrl: string | null;
  productUrl: string;
  priceLabel: string;
  email: string;
  shipping: Shipping | null;
}

type Phase =
  | 'idle'
  | 'running'
  | 'address'
  | 'buying'
  | 'placed'
  | 'declined'
  | 'manual'
  | 'failed';

export function CheckoutFlow(props: CheckoutFlowProps) {
  const {
    sessionId,
    checkoutUrl,
    expiresAt,
    orderId,
    itemId,
    title,
    merchant,
    imageUrl,
    productUrl,
    priceLabel,
    email,
    shipping,
  } = props;

  const merchantName = merchant ?? 'the merchant';

  const [phase, setPhase] = useState<Phase>('idle');
  const [stage, setStage] = useState(0);
  const [card, setCard] = useState<Credentials | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [passkeyReady, setPasskeyReady] = useState<boolean | null>(null);
  const [fallbackAvailable, setFallbackAvailable] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [slowPasskey, setSlowPasskey] = useState(false);
  const [watch, setWatch] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    const embedded = /Electron\/|Code\/|; wv\)/.test(navigator.userAgent);
    if (embedded) return setPasskeyReady(false);

    const probe = window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable;
    if (!probe) return setPasskeyReady(false);

    probe
      .call(window.PublicKeyCredential)
      .then((available) => setPasskeyReady(available))
      .catch(() => setPasskeyReady(false));
  }, []);

  const fail = useCallback((message: string) => {
    setError(message);
    setPhase('failed');
  }, []);

  const placeOrder = useCallback(
    // `useFallback` is passed explicitly because the callers that switch to the
    // demo card call placeOrder in the same tick as setFallback — the closure
    // would still see the stale `false`.
    async (address: Shipping, useFallback = fallback) => {
      setPhase('buying');
      setStage(3);

      let result: { status?: string; message?: string; url?: string };
      try {
        const res = await fetch(`/api/place-order/${sessionId}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            itemId,
            shipping: { ...address, email },
            watch: watch || new URLSearchParams(window.location.search).get('watch') === '1',
            fallback: useFallback,
          }),
        });
        result = await res.json();
      } catch (err) {
        result = { status: 'failed', message: err instanceof Error ? err.message : String(err) };
      }

      if (result.status === 'placed') {
        setStage(5);
        setNote(result.url ?? null);
        return setPhase('placed');
      }
      if (result.status === 'declined') {
        setStage(5);
        setNote(result.message ?? null);
        return setPhase('declined');
      }

      setNote(result.message ?? 'The agent could not complete the checkout.');
      setPhase('manual');
    },
    [email, fallback, itemId, sessionId, watch],
  );

  const reportManually = useCallback(
    async (status: 'APPROVED' | 'DECLINED') => {
      setStage(4);
      try {
        const res = await fetch(`/api/report-status/${sessionId}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status }),
        });
        const settled = await res.json();
        if (!settled.ok) {
          setNote(settled.message ?? 'Could not report the outcome to Prava.');
          return setPhase('manual');
        }
      } catch (err) {
        setNote(err instanceof Error ? err.message : String(err));
        return setPhase('manual');
      }
      setStage(5);
      setNote(null);
      setPhase(status === 'APPROVED' ? 'placed' : 'declined');
    },
    [sessionId],
  );

  const start = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    if (props.fallbackDirect) {
      setFallbackAvailable(true);
      setFallback(true);
      setPhase('running');
      setStage(3);
      if (shipping) return void placeOrder(shipping, true);
      return setPhase('address');
    }

    const tab = window.open(checkoutUrl, '_blank', 'noopener');
    if (!tab) setPopupBlocked(true);

    setPhase('running');
    window.setTimeout(() => setStage(1), 600);

    const deadline = Date.parse(expiresAt) || Date.now() + 15 * 60_000;

    const minted = (credentials: Credentials) => {
      setCard(credentials);
      setStage(3);
      if (shipping) return void placeOrder(shipping);
      setPhase('address');
    };

    const poll = async () => {
      if (Date.now() > deadline) {
        return fail('This session expired before it was authorized. Start a new checkout.');
      }

      let body;
      try {
        const res = await fetch(`/api/payment-result/${sessionId}`);
        if (!res.ok) throw new Error(`payment-result returned ${res.status}`);
        body = await res.json();
        if (body.fallbackAvailable) setFallbackAvailable(true);
      } catch (err) {
        console.error('poll failed, retrying', err);
        return void window.setTimeout(poll, 3000);
      }

      if (body.credentials) {
        setStage(2);
        window.setTimeout(() => minted(body.credentials), 700);
        return;
      }

      if (body.status === 'failed') {
        const code = body.error?.code;
        return fail([code, body.error?.message ?? 'Authorization failed.'].filter(Boolean).join(': '));
      }

      window.setTimeout(poll, 2000);
    };

    void poll();
  }, [checkoutUrl, expiresAt, fail, placeOrder, props.fallbackDirect, sessionId, shipping]);

  useEffect(() => {
    if (!(fallbackAvailable && phase === 'running' && !card)) return;
    const t = window.setTimeout(() => setSlowPasskey(true), 20_000);
    return () => window.clearTimeout(t);
  }, [fallbackAvailable, phase, card]);

  const useFallbackCard = () => {
    setFallback(true);
    setStage(3);
    if (shipping) return void placeOrder(shipping, true);
    setPhase('address');
  };

  const settled = phase === 'placed';

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8 sm:py-12">
      <div
        className={`grid items-start gap-8 ${
          imageUrl ? 'lg:grid-cols-2 lg:gap-16' : 'max-w-xl'
        }`}
      >
        {imageUrl && <Artwork imageUrl={imageUrl} title={title} settled={settled} />}

        <div className="flex flex-col">
          <div className="rounded-2xl border border-hairline bg-white p-6 shadow-card sm:p-8">
            <span className="inline-block rounded-full border border-hairline bg-paper px-3 py-1 text-[11px] tracking-[0.12em] text-ink-soft uppercase">
              Sandbox — test purchase, no real money
            </span>
            <p className="mt-4 text-[12px] font-medium tracking-wide text-ink-soft uppercase">
              {merchantName}
            </p>
            <h1 className="mt-2 font-serif text-[32px] leading-[1.05] tracking-[-0.01em] text-ink sm:text-[40px]">
              {title}
            </h1>
            <p className="text-gradient-accent mt-4 font-serif text-[56px] leading-none tracking-[-0.01em] sm:text-[72px]">
              {priceLabel}
            </p>

            <div className="mt-8">
              {phase === 'idle' ? (
                <div>
                  <Guardrails merchant={merchantName} priceLabel={priceLabel} />
                  {passkeyReady === false && (
                    <div className="mt-8 rounded-2xl border border-amber/40 bg-amber-soft p-4">
                      <p className="text-[13px] leading-relaxed text-amber">
                        This browser reports no passkey support — Prava needs Touch ID, Face ID or
                        Windows Hello. Open this page in Google Chrome (choose "Chrome profile" when
                        asked where to save the passkey), or turn on iCloud Keychain for Safari.
                      </p>
                    </div>
                  )}
                  <label className="mt-6 flex cursor-pointer items-center gap-3 text-[13px] text-ink-soft">
                    <input
                      type="checkbox"
                      checked={watch}
                      onChange={(e) => setWatch(e.target.checked)}
                      className="h-4 w-4 rounded border-hairline accent-[#1C1B1A]"
                    />
                    Show the browser while the agent buys
                  </label>
                  <BuyButton onClick={start} />
                </div>
              ) : (
                <div>
                  {fallback && phase !== 'idle' && (
                    <p className="mb-4 inline-block rounded-full border border-amber/40 bg-amber-soft px-3 py-1 text-[12px] font-medium text-amber">
                      Demo mode — sandbox test card, Prava passkey skipped.
                    </p>
                  )}
                  <Timeline stage={stage} merchant={merchantName} phase={phase} />

                  {fallbackAvailable && !fallback && phase === 'running' && !card && slowPasskey && (
                    <button
                      type="button"
                      onClick={useFallbackCard}
                      className="motion mt-4 text-[13px] font-medium text-ink-soft underline decoration-hairline underline-offset-4 hover:text-ink"
                    >
                      Passkey trouble? Continue with a sandbox test card (demo)
                    </button>
                  )}

                  <p className="mt-4 font-mono text-[11px] text-ink-soft">Order {orderId}</p>

                  {phase === 'buying' && (
                    <p className="mt-4 text-[13px] leading-relaxed text-ink-soft">
                      The agent is filling {merchantName}'s checkout with the one-time card. This
                      takes a minute, and a captcha may need clearing in the worker's window.
                    </p>
                  )}

                  {popupBlocked && phase === 'running' && !card && (
                    <a
                      href={checkoutUrl}
                      target="_blank"
                      rel="noopener"
                      className="bg-gradient-accent mt-6 block rounded-full px-6 py-3 text-center text-[15px] font-medium text-ink"
                    >
                      Open the Prava tab
                    </a>
                  )}

                  {phase === 'address' && (
                    <AddressForm email={email} onSubmit={(address) => void placeOrder(address)} />
                  )}

                  {phase === 'placed' && (
                    <Outcome
                      heading={`Bought at ${merchantName}`}
                      body="Reported to Prava as APPROVED. The one-time card is spent and cannot be used again."
                      link={note && note.startsWith('http') ? { href: note, label: 'View the order' } : null}
                    />
                  )}

                  {phase === 'declined' && (
                    <Outcome
                      heading={`Declined at ${merchantName}`}
                      body={`Reported to Prava as DECLINED.${note ? ` ${note.replace(/\.?$/, '.')}` : ''} Tokens are single-use, so this one is dead — start a new checkout to try again.`}
                      link={null}
                      tone="amber"
                    />
                  )}

                  {phase === 'manual' && card && (
                    <ManualSettle
                      card={card}
                      note={note}
                      merchant={merchantName}
                      productUrl={productUrl}
                      onReport={reportManually}
                    />
                  )}

                  {error && (
                    <div className="mt-6 rounded-2xl border border-hairline bg-paper p-4">
                      <p className="text-[13px] leading-relaxed text-ink-soft">{error}</p>
                      <a
                        href="/dashboard"
                        className="mt-3 inline-block text-[13px] font-medium text-ink uppercase underline underline-offset-4"
                      >
                        Back to finds
                      </a>
                      {fallbackAvailable && !fallback && (
                        <button
                          type="button"
                          onClick={useFallbackCard}
                          className="motion mt-4 block w-full rounded-full border border-hairline bg-white px-6 py-3 text-[15px] font-medium text-ink hover:border-ink-soft"
                        >
                          Continue with sandbox test card
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Artwork({
  imageUrl,
  title,
  settled,
}: {
  imageUrl: string;
  title: string;
  settled: boolean;
}) {
  return (
    <div className="relative mx-auto w-full max-w-[360px] overflow-hidden rounded-2xl border border-hairline bg-white shadow-card lg:max-w-none">
      <div className="aspect-[4/5] w-full overflow-hidden bg-paper">
        <img src={imageUrl} alt={title} className="h-full w-full object-cover" />
      </div>

      {settled && (
        <div className="absolute inset-x-0 bottom-0 flex h-20 items-center justify-center bg-white/95">
          <span className="text-gradient-accent font-serif text-[32px] leading-none tracking-[-0.01em] sm:text-[44px]">
            bought
          </span>
        </div>
      )}
    </div>
  );
}

function Guardrails({ merchant, priceLabel }: { merchant: string; priceLabel: string }) {
  const lines = [
    <>
      Works <strong className="font-medium text-ink">once</strong>, then it's dead
    </>,
    <>
      Locked to <strong className="font-medium text-ink">{merchant}</strong>
    </>,
    <>
      Capped at <strong className="font-medium text-ink">{priceLabel}</strong>
    </>,
    <>Your real card never reaches the merchant, or us</>,
  ];

  return (
    <ul className="space-y-2.5">
      {lines.map((line, i) => (
        <li
          key={i}
          className="flex gap-3 text-[13px] leading-relaxed text-ink-soft sm:text-[15px]"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 16 10"
            className="mt-[6px] h-[10px] w-4 shrink-0 text-ink-soft"
            fill="none"
          >
            <path
              d="M2 5.5 C 5 2.5, 8 7.5, 11 4.5 S 14 4, 14.5 4.5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}

function BuyButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="motion mt-8 flex h-[80px] w-full items-center justify-center rounded-full bg-gradient-accent hover:scale-[1.01] sm:h-[100px]"
    >
      <span className="font-serif text-[28px] leading-none tracking-[-0.01em] text-ink sm:text-[34px]">
        buy
      </span>
    </button>
  );
}

function Timeline({ stage, merchant, phase }: { stage: number; merchant: string; phase: Phase }) {
  const list = steps(merchant);
  const stalled = phase === 'manual' || phase === 'failed' || phase === 'address';

  const label = (i: number, key: 'active' | 'done') =>
    i === 3 && key === 'done' && phase === 'declined' ? `Declined at ${merchant}` : list[i][key];

  const progress = Math.min(1, stage / list.length);

  return (
    <div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-paper">
        <div
          className="bg-gradient-accent h-full rounded-full transition-all duration-500"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
      <ol className="mt-4 border-t border-paper">
        {list.map((step, i) => {
          const done = stage > i;
          const active = stage === i && !stalled;
          const blocked = stage === i && stalled;
          return (
            <li
              key={step.done}
              className="flex items-center gap-4 border-b border-paper py-4"
            >
              <StepMark done={done} active={active} blocked={blocked} />
              <span
                className={`text-[15px] font-medium tracking-[-0.02em] transition-colors duration-300 sm:text-[18px] ${
                  done
                    ? 'text-ink'
                    : blocked
                      ? 'text-amber'
                      : active
                        ? 'text-ink'
                        : 'text-ink-soft'
                }`}
              >
                {done ? label(i, 'done') : label(i, 'active')}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function StepMark({ done, active, blocked }: { done: boolean; active: boolean; blocked: boolean }) {
  return (
    <span
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium transition-colors duration-300 ${
        done
          ? 'bg-gradient-accent border-transparent text-ink'
          : blocked
            ? 'border-amber/40 text-amber'
            : active
              ? 'border-ink text-ink'
              : 'border-hairline text-hairline'
      }`}
    >
      {done ? '✓' : blocked ? '!' : ''}
    </span>
  );
}

const FIELD =
  'w-full rounded-full border border-hairline bg-white px-5 py-3 text-[13px] tracking-[-0.02em] text-ink placeholder:text-ink-soft focus:border-ink focus:outline-none';

function AddressForm({
  email,
  onSubmit,
}: {
  email: string;
  onSubmit: (shipping: Shipping) => void;
}) {
  return (
    <form
      className="mt-6"
      onSubmit={(event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(event.currentTarget).entries());
        onSubmit(data as unknown as Shipping);
      }}
    >
      <p className="text-[11px] font-medium tracking-wide text-ink-soft uppercase">
        Where should it ship? Saved for next time.
      </p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <input name="firstName" required placeholder="First name" className={FIELD} />
        <input name="lastName" required placeholder="Last name" className={FIELD} />
        <input name="address1" required placeholder="Address" className={`col-span-2 ${FIELD}`} />
        <input name="city" required placeholder="City" className={FIELD} />
        <input name="postalCode" required placeholder="PIN / ZIP" className={FIELD} />
        <input name="province" placeholder="State" className={FIELD} />
        <input name="phone" placeholder="Phone" className={FIELD} />
        <input name="countryCode" required defaultValue="US" placeholder="Country" className={`col-span-2 ${FIELD}`} />
      </div>
      <p className="mt-3 text-[11px] text-ink-soft">Confirmation goes to {email}</p>
      <button
        type="submit"
        className="bg-gradient-accent mt-4 w-full rounded-full px-6 py-3.5 text-[15px] font-medium text-ink motion hover:scale-[1.01]"
      >
        Buy it for me
      </button>
    </form>
  );
}

function Outcome({
  heading,
  body,
  link,
  tone = 'white',
}: {
  heading: string;
  body: string;
  link: { href: string; label: string } | null;
  tone?: 'white' | 'amber';
}) {
  return (
    <div
      className={`mt-6 rounded-2xl border p-5 ${
        tone === 'amber' ? 'border-amber/40 bg-amber-soft' : 'border-hairline bg-paper'
      }`}
    >
      <span
        className={`inline-block rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase ${
          tone === 'amber'
            ? 'border-amber/40 text-amber'
            : 'bg-gradient-accent border-transparent text-ink'
        }`}
      >
        {tone === 'amber' ? 'Declined' : 'Placed'}
      </span>
      <p
        className={`mt-3 text-[20px] leading-none font-medium tracking-[-0.03em] ${
          tone === 'amber' ? 'text-amber' : 'text-ink'
        }`}
      >
        {heading}
      </p>
      <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">{body}</p>
      {link && (
        <a
          href={link.href}
          target="_blank"
          rel="noopener nofollow"
          className="mt-4 block rounded-full border border-hairline px-6 py-3 text-center text-[15px] font-medium text-ink motion hover:border-ink"
        >
          {link.label}
        </a>
      )}
    </div>
  );
}

function ManualSettle({
  card,
  note,
  merchant,
  productUrl,
  onReport,
}: {
  card: Credentials;
  note: string | null;
  merchant: string;
  productUrl: string;
  onReport: (status: 'APPROVED' | 'DECLINED') => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(card.token);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="mt-6">
      {note && <p className="text-[13px] leading-relaxed text-amber">{note}</p>}
      <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
        The card is minted and still valid. Finish at {merchant} yourself, then tell us how it went —
        Prava needs the outcome to close the session.
      </p>

      <div className="mt-5 rounded-2xl border border-hairline bg-paper p-5">
        <div className="flex items-baseline justify-between">
          <p className="text-[11px] font-medium tracking-wide text-ink-soft uppercase">
            One-time card
          </p>
          <button
            type="button"
            onClick={copy}
            className="text-[11px] font-medium text-ink uppercase underline underline-offset-4"
          >
            {copied ? 'Copied' : 'Copy number'}
          </button>
        </div>

        <p className="mt-4 font-mono text-[20px] tracking-[0.08em] text-ink sm:text-[26px]">
          {card.token.replace(/(.{4})/g, '$1 ').trim()}
        </p>

        <dl className="mt-4 flex gap-8 font-mono text-[13px] text-ink-soft">
          <div>
            <dt className="text-[10px] tracking-wide text-ink-soft uppercase">CVV</dt>
            <dd className="mt-0.5 text-ink">{card.dynamicCvv}</dd>
          </div>
          <div>
            <dt className="text-[10px] tracking-wide text-ink-soft uppercase">Expiry</dt>
            <dd className="mt-0.5 text-ink">
              {card.expiryMonth}/{card.expiryYear}
            </dd>
          </div>
        </dl>
      </div>

      <a
        href={productUrl}
        target="_blank"
        rel="noopener nofollow"
        className="bg-gradient-accent mt-4 block rounded-full px-6 py-4 text-center text-[15px] font-medium text-ink sm:text-[20px]"
      >
        Finish at {merchant}
      </a>

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={() => onReport('APPROVED')}
          className="flex-1 rounded-full border border-hairline px-4 py-3 text-[13px] font-medium text-ink uppercase motion hover:border-ink"
        >
          It went through
        </button>
        <button
          type="button"
          onClick={() => onReport('DECLINED')}
          className="flex-1 rounded-full border border-hairline px-4 py-3 text-[13px] font-medium text-ink uppercase motion hover:border-ink"
        >
          It failed
        </button>
      </div>
    </div>
  );
}
