import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';

const EASE = [0.25, 0.1, 0.25, 1] as const;

const SYMBOLS = ['8', '$', '^^', '%', '/'];

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
    async (address: Shipping) => {
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
            watch: new URLSearchParams(window.location.search).get('watch') === '1',
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
    [email, itemId, sessionId],
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
  }, [checkoutUrl, expiresAt, fail, placeOrder, sessionId, shipping]);

  const settled = phase === 'placed';

  return (
    <div className="relative flex min-h-dvh flex-col px-4 pt-4 pb-10 sm:px-8 sm:pt-8 sm:pb-8">
      <div
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          background: 'radial-gradient(120% 80% at 50% -10%, rgba(255,255,255,0.10), transparent 60%)',
        }}
      />

      <Chrome merchant={merchantName} />

      <div
        className={`relative z-10 mx-auto grid w-full flex-1 items-center gap-8 pt-14 sm:pt-20 ${
          imageUrl ? 'max-w-6xl lg:grid-cols-2 lg:gap-16' : 'max-w-xl'
        }`}
      >
        {imageUrl && <Artwork imageUrl={imageUrl} title={title} settled={settled} />}

        <div className="flex flex-col">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: EASE }}
          >
            <p className="mb-4 inline-block w-fit border border-white/15 px-3 py-1.5 text-[11px] font-medium tracking-[-0.02em] text-white/50 uppercase sm:text-[12px]">
              Sandbox — test purchase, no real money
            </p>
            <p className="text-[11px] font-medium tracking-[-0.02em] text-white/40 uppercase sm:text-[13px]">
              {merchantName}
            </p>
            <h1 className="mt-3 text-[30px] leading-[0.95] font-medium tracking-[-0.04em] text-white sm:text-[44px]">
              {title}
            </h1>
            <p className="mt-4 text-[60px] leading-none font-medium tracking-[-0.04em] text-white sm:text-[80px]">
              {priceLabel}
            </p>
          </motion.div>

          <div className="mt-8">
            <AnimatePresence mode="wait">
              {phase === 'idle' ? (
                <motion.div
                  key="idle"
                  exit={{ opacity: 0, y: -12 }}
                  transition={{ duration: 0.35, ease: EASE }}
                >
                  <Guardrails merchant={merchantName} priceLabel={priceLabel} />
                  {passkeyReady === false && (
                    <div className="mt-8 border border-amber-300/40 p-4">
                      <p className="text-[13px] leading-relaxed text-amber-300/90">
                        This browser reports no passkey — Prava needs Face ID, Touch ID or Windows
                        Hello. You can still try, but if it dies at authorization, open the page in
                        Safari or Chrome on a device that has one.
                      </p>
                    </div>
                  )}
                  <BuyButton onClick={start} />
                </motion.div>
              ) : (
                <motion.div
                  key="running"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.45, ease: EASE, delay: 0.1 }}
                >
                  <Timeline
                    stage={stage}
                    merchant={merchantName}
                    phase={phase}
                  />

                  <p className="mt-4 font-mono text-[11px] text-white/25">Order {orderId}</p>

                  {phase === 'buying' && (
                    <p className="mt-4 text-[13px] leading-relaxed text-white/40">
                      The agent is filling {merchantName}'s checkout with the one-time card. This
                      takes a minute, and a captcha may need clearing in the worker's window.
                    </p>
                  )}

                  {popupBlocked && phase === 'running' && !card && (
                    <a
                      href={checkoutUrl}
                      target="_blank"
                      rel="noopener"
                      className="mt-6 block rounded-full bg-white px-6 py-3 text-center text-[15px] font-medium tracking-[-0.02em] text-black"
                    >
                      Open the Prava tab
                    </a>
                  )}

                  {phase === 'address' && (
                    <AddressForm
                      email={email}
                      onSubmit={(address) => void placeOrder(address)}
                    />
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
                    <div className="mt-6 border border-white/15 p-4">
                      <p className="text-[13px] leading-relaxed text-white/70">{error}</p>
                      <a
                        href="/dashboard"
                        className="mt-3 inline-block text-[13px] font-medium tracking-[-0.02em] text-white uppercase underline underline-offset-4"
                      >
                        Back to finds
                      </a>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}

function Chrome({ merchant }: { merchant: string }) {
  return (
    <div className="pointer-events-none absolute inset-x-4 top-4 z-20 flex items-start justify-between sm:inset-x-8 sm:top-8">
      <a href="/dashboard" className="pointer-events-auto w-[110px] sm:w-[160px]">
        <svg viewBox="0 0 355 110" className="w-full">
          <text x="0" y="75" fill="#ffffff" fontSize="72" fontWeight="500" letterSpacing="-2">
            SENDIT
          </text>
        </svg>
      </a>
      <div className="pointer-events-auto flex items-center gap-4 sm:gap-6">
        <span className="hidden text-[13px] font-medium tracking-[-0.02em] text-white/40 uppercase sm:inline">
          Paying {merchant}
        </span>
        <a
          href="/dashboard"
          className="text-[13px] font-medium tracking-[-0.02em] text-white uppercase sm:text-[15px]"
        >
          [ close ]
        </a>
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
    <motion.div
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.7, ease: EASE }}
      className="relative mx-auto w-full max-w-[320px] lg:max-w-none"
    >
      <div className="h-[34dvh] w-full overflow-hidden bg-white/5 lg:aspect-[2/3] lg:h-auto">
        <img src={imageUrl} alt={title} className="h-full w-full object-cover" />
      </div>

      <AnimatePresence>
        {settled && (
          <motion.div
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, ease: EASE }}
            className="absolute inset-x-0 bottom-0 flex h-24 items-center justify-center bg-white"
          >
            <span className="text-[40px] leading-none font-medium tracking-[-0.04em] text-black sm:text-[56px]">
              bought
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function Guardrails({ merchant, priceLabel }: { merchant: string; priceLabel: string }) {
  const lines = [
    <>
      Works <strong className="font-medium text-white">once</strong>, then it's dead
    </>,
    <>
      Locked to <strong className="font-medium text-white">{merchant}</strong>
    </>,
    <>
      Capped at <strong className="font-medium text-white">{priceLabel}</strong>
    </>,
    <>Your real card never reaches the merchant, or us</>,
  ];

  return (
    <ul className="space-y-2.5">
      {lines.map((line, i) => (
        <motion.li
          key={i}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE, delay: 0.2 + i * 0.08 }}
          className="flex gap-3 text-[13px] leading-relaxed text-white/50 sm:text-[15px]"
        >
          <span aria-hidden="true">→</span>
          <span>{line}</span>
        </motion.li>
      ))}
    </ul>
  );
}

function BuyButton({ onClick }: { onClick: () => void }) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      initial={{ scale: 0 }}
      animate={{ scale: 1 }}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      transition={{ duration: 0.6, ease: EASE, delay: 0.5 }}
      style={{ transformOrigin: 'left bottom' }}
      className="mt-8 flex h-[100px] w-full items-center justify-center rounded-full bg-white sm:h-[130px]"
    >
      <span className="text-[64px] leading-none font-medium tracking-[-0.04em] text-black sm:text-[80px]">
        buy
      </span>
    </motion.button>
  );
}

function Timeline({ stage, merchant, phase }: { stage: number; merchant: string; phase: Phase }) {
  const list = steps(merchant);
  const stalled = phase === 'manual' || phase === 'failed' || phase === 'address';

  const label = (i: number, key: 'active' | 'done') =>
    i === 3 && key === 'done' && phase === 'declined' ? `Declined at ${merchant}` : list[i][key];

  return (
    <ol className="border-t border-white/10">
      {list.map((step, i) => {
        const done = stage > i;
        const active = stage === i && !stalled;
        const blocked = stage === i && stalled;
        return (
          <li
            key={step.done}
            className="flex items-center gap-4 border-b border-white/10 py-4 sm:py-5"
          >
            <StepMark done={done} active={active} blocked={blocked} />
            <span
              className={`text-[15px] font-medium tracking-[-0.02em] transition-colors duration-300 sm:text-[20px] ${
                done
                  ? 'text-white'
                  : blocked
                    ? 'text-amber-300'
                    : active
                      ? 'text-white/70'
                      : 'text-white/25'
              }`}
            >
              {done ? label(i, 'done') : label(i, 'active')}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function StepMark({ done, active, blocked }: { done: boolean; active: boolean; blocked: boolean }) {
  const [symbol, setSymbol] = useState(SYMBOLS[0]);

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(
      () => setSymbol(SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)]),
      140,
    );
    return () => window.clearInterval(id);
  }, [active]);

  return (
    <span
      className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium transition-colors duration-300 sm:h-[30px] sm:w-[30px] ${
        done
          ? 'border-white bg-white text-black'
          : blocked
            ? 'border-amber-300 text-amber-300'
            : active
              ? 'border-white text-white'
              : 'border-white/20 text-white/20'
      }`}
    >
      {done ? '✓' : blocked ? '!' : active ? symbol : ''}
      {active && (
        <motion.span
          className="absolute inset-0 rounded-full border border-white"
          animate={{ scale: [1, 1.6], opacity: [0.6, 0] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: 'easeOut' }}
        />
      )}
    </span>
  );
}

const FIELD =
  'w-full rounded-full border border-white/20 bg-transparent px-4 py-2.5 text-[13px] tracking-[-0.02em] text-white placeholder:text-white/30 focus:border-white focus:outline-none';

function AddressForm({
  email,
  onSubmit,
}: {
  email: string;
  onSubmit: (shipping: Shipping) => void;
}) {
  return (
    <motion.form
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: EASE }}
      className="mt-6"
      onSubmit={(event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(event.currentTarget).entries());
        onSubmit(data as unknown as Shipping);
      }}
    >
      <p className="text-[11px] font-medium tracking-[-0.02em] text-white/40 uppercase">
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
      <p className="mt-3 text-[11px] text-white/30">Confirmation goes to {email}</p>
      <button
        type="submit"
        className="mt-4 w-full rounded-full bg-white px-6 py-4 text-[15px] font-medium tracking-[-0.02em] text-black sm:text-[20px]"
      >
        Buy it for me
      </button>
    </motion.form>
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
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: EASE }}
      className={`mt-6 border p-5 ${tone === 'amber' ? 'border-amber-300/40' : 'border-white/15'}`}
    >
      <p
        className={`text-[20px] leading-none font-medium tracking-[-0.04em] ${
          tone === 'amber' ? 'text-amber-300' : 'text-white'
        }`}
      >
        {heading}
      </p>
      <p className="mt-3 text-[13px] leading-relaxed text-white/50">{body}</p>
      {link && (
        <a
          href={link.href}
          target="_blank"
          rel="noopener nofollow"
          className="mt-4 block rounded-full bg-white px-6 py-3 text-center text-[15px] font-medium tracking-[-0.02em] text-black"
        >
          {link.label}
        </a>
      )}
    </motion.div>
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
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: EASE }}
      className="mt-6"
    >
      {note && <p className="text-[13px] leading-relaxed text-amber-300/80">{note}</p>}
      <p className="mt-3 text-[13px] leading-relaxed text-white/50">
        The card is minted and still valid. Finish at {merchant} yourself, then tell us how it went —
        Prava needs the outcome to close the session.
      </p>

      <div className="mt-5 border border-white/15 bg-white/[0.04] p-5">
        <div className="flex items-baseline justify-between">
          <p className="text-[11px] font-medium tracking-[-0.02em] text-white/40 uppercase">
            One-time card
          </p>
          <button
            type="button"
            onClick={copy}
            className="text-[11px] font-medium tracking-[-0.02em] text-white uppercase underline underline-offset-4"
          >
            {copied ? 'Copied' : 'Copy number'}
          </button>
        </div>

        <p className="mt-4 font-mono text-[20px] tracking-[0.08em] text-white sm:text-[26px]">
          {card.token.replace(/(.{4})/g, '$1 ').trim()}
        </p>

        <dl className="mt-4 flex gap-8 font-mono text-[13px] text-white/60">
          <div>
            <dt className="text-[10px] tracking-[-0.02em] text-white/30 uppercase">CVV</dt>
            <dd className="mt-0.5 text-white">{card.dynamicCvv}</dd>
          </div>
          <div>
            <dt className="text-[10px] tracking-[-0.02em] text-white/30 uppercase">Expiry</dt>
            <dd className="mt-0.5 text-white">
              {card.expiryMonth}/{card.expiryYear}
            </dd>
          </div>
        </dl>
      </div>

      <a
        href={productUrl}
        target="_blank"
        rel="noopener nofollow"
        className="mt-4 block rounded-full bg-white px-6 py-4 text-center text-[15px] font-medium tracking-[-0.02em] text-black sm:text-[20px]"
      >
        Finish at {merchant}
      </a>

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={() => onReport('APPROVED')}
          className="flex-1 rounded-full border border-white/20 px-4 py-3 text-[13px] font-medium tracking-[-0.02em] text-white/70 uppercase hover:border-white hover:text-white"
        >
          It went through
        </button>
        <button
          type="button"
          onClick={() => onReport('DECLINED')}
          className="flex-1 rounded-full border border-white/20 px-4 py-3 text-[13px] font-medium tracking-[-0.02em] text-white/70 uppercase hover:border-white hover:text-white"
        >
          It failed
        </button>
      </div>
    </motion.div>
  );
}
