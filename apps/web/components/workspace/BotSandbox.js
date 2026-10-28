import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Segmented, Spinner, cx } from '../ui';
import { IconBolt, IconSend, IconShield, IconSpark } from '../ui/icons';
import { ChatText } from '../ui/ChatText';
import { botsFor } from '../../lib/botPreferences';

// Side-by-side sandbox: one composer, the Support Bot and the Sales Bot
// answering in their own panes. Runs through ws.chat, i.e. the signed-in
// session — same engine, knowledge and rate limit as the embedded widget.
//
// Starter chips come from ws.getFaqs(): questions an LLM wrote from this
// tenant's own documents after signup or an import. Until those are ready
// (or if generation failed) each pane shows the generic starters below.

const BOTS = [
  { id: 'support', name: 'Support Bot', icon: IconShield, tone: 'blue', blurb: 'Grounded, factual answers. Hands off when unsure.',
    faqKey: 'supportFaqs', starters: ['How do I get started?', 'What is your refund policy?'],
    startersHi: ['मैं कैसे शुरू करूँ?', 'आपकी रिफ़ंड नीति क्या है?'] },
  { id: 'sales', name: 'Sales Bot', icon: IconBolt, tone: 'green', blurb: 'Persuasive, benefit-led, ends with a next step.',
    faqKey: 'salesFaqs', starters: ['Why should we choose you?', 'How does your pricing work?'],
    startersHi: ['हम आपको क्यों चुनें?', 'आपकी कीमत कैसे तय होती है?'] }
];

const FAQ_POLL_MS = 4000;
const FAQ_POLL_MAX = 30; // ~2 minutes, then settle for the generic starters

const LANGUAGES = [{ value: 'en', label: 'English' }, { value: 'hi', label: 'हिंदी' }];

// Loads the tenant's starter FAQs, polling while the API reports "pending".
function useStarterFaqs(ws) {
  const [faqs, setFaqs] = useState(null);
  const [polls, setPolls] = useState(0);

  const load = useCallback(async () => {
    try {
      setFaqs(await ws.getFaqs());
    } catch {
      setFaqs({ status: 'failed', supportFaqs: [], salesFaqs: [] }); // generic starters still work
    }
  }, [ws]);

  useEffect(() => { if (ws) { setPolls(0); load(); } }, [ws, load]);

  useEffect(() => {
    if (faqs?.status !== 'pending' || polls >= FAQ_POLL_MAX) return undefined;
    const t = setTimeout(() => { setPolls((n) => n + 1); load(); }, FAQ_POLL_MS);
    return () => clearTimeout(t);
  }, [faqs, polls, load]);

  const regenerate = async () => {
    try {
      await ws.regenerateFaqs();
      setPolls(0);
      setFaqs((f) => ({ ...(f || { supportFaqs: [], salesFaqs: [] }), status: 'pending' }));
    } catch (err) {
      setFaqs((f) => ({ ...(f || { supportFaqs: [], salesFaqs: [] }), notice: err.message }));
    }
  };

  const generating = faqs?.status === 'pending' && polls < FAQ_POLL_MAX;
  return { faqs, generating, regenerate };
}

export default function BotSandbox({ ws, tenant }) {
  // Only the bots this company deploys (Tenant.botPreference). The session's
  // tenant can lag a change made on the Overview, so the knowledge split's
  // answer — which carries the current preference — has the last word.
  const [deployed, setDeployed] = useState(() => botsFor(tenant.botPreference));
  const [split, setSplit] = useState(null);
  const deployedAtMount = useRef(botsFor(tenant.botPreference).length);
  const [target, setTarget] = useState(() => (botsFor(tenant.botPreference).length === 1 ? botsFor(tenant.botPreference)[0] : 'both'));
  useEffect(() => {
    ws.getKnowledgeDistribution().then((d) => {
      setSplit(d);
      const bots = botsFor(d.botPreference);
      setDeployed(bots);
      // One bot: send to it. Both: keep a choice made here, but not one left
      // over from a stale single-bot session (that would hide the comparison).
      setTarget((t) => (bots.length === 1 ? bots[0] : bots.length !== deployedAtMount.current ? 'both' : t));
    }).catch((e) => setSplit({ error: e.message })); // the panes still work on the session's preference
  }, [ws]);
  const single = deployed.length === 1;
  const visibleBots = BOTS.filter((b) => deployed.includes(b.id));
  const [threads, setThreads] = useState({ support: [], sales: [] });
  const [sessions, setSessions] = useState({});
  const [pending, setPending] = useState({ support: false, sales: false });
  const [input, setInput] = useState('');
  // The top-level reply language, sent as `language` on every chat request.
  // It is authoritative: the bot answers in this language whatever the
  // question is typed in (apps/api/src/engine/language.js).
  const [lang, setLang] = useState('en');
  const inputRef = useRef(null);
  const { faqs, generating, regenerate } = useStarterFaqs(ws);

  const ask = async (bot, query) => {
    setThreads((t) => ({ ...t, [bot]: [...t[bot], { role: 'user', text: query }] }));
    setPending((p) => ({ ...p, [bot]: true }));
    try {
      const data = await ws.chat({ query, botType: bot, sessionId: sessions[bot], language: lang });
      setSessions((s) => ({ ...s, [bot]: data.sessionId }));
      setThreads((t) => ({ ...t, [bot]: [...t[bot], { role: 'bot', text: data.answer, meta: data }] }));
    } catch (err) {
      setThreads((t) => ({ ...t, [bot]: [...t[bot], { role: 'bot', text: err.message, error: true }] }));
    } finally {
      setPending((p) => ({ ...p, [bot]: false }));
    }
  };

  const send = (text) => {
    const query = String(text ?? input).trim();
    if (!query) return;
    setInput('');
    const bots = target === 'both' ? ['support', 'sales'] : [target];
    bots.forEach((b) => ask(b, query));
    inputRef.current?.focus();
  };

  const busy = (target === 'both' ? pending.support || pending.sales : pending[target]);
  const reset = () => { setThreads({ support: [], sales: [] }); setSessions({}); };
  const [view, setView] = useState('chat');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented label="View" value={view} onChange={setView}
            options={[{ value: 'chat', label: single ? 'Test chat' : 'Compare answers' }, { value: 'knowledge', label: single ? 'Knowledge' : 'Knowledge split' }]} />
          {view === 'chat' && <Segmented label="Language" value={lang} onChange={setLang} options={LANGUAGES} />}
        </div>
        <p className="text-xs text-fg-3">
          {view === 'chat'
            ? (single ? `Only your ${deployed[0] === 'sales' ? 'Sales' : 'Support'} Bot is deployed — switch on the Overview page.`
              : 'Ask both bots the same question to see how each answers from its own knowledge.')
            : single ? 'The sections of your documents your bot answers from.' : 'Which sections of your documents each bot answers from.'}
        </p>
      </div>
      {view === 'knowledge' && <KnowledgeSplit data={split} deployed={deployed} />}
      <div className={cx('grid gap-4', !single && 'lg:grid-cols-2', view !== 'chat' && 'hidden')}>
        {visibleBots.map((bot) => {
          // Starter chips in the selected language: the Hindi FAQ variants when
          // the toggle is on Hindi (falling back to English if none), and the
          // Hindi generic starters otherwise.
          const hiFaqs = faqs?.[`${bot.faqKey}Hi`] || [];
          const tailored = (lang === 'hi' && hiFaqs.length ? hiFaqs : faqs?.[bot.faqKey]) || [];
          const generic = lang === 'hi' ? bot.startersHi : bot.starters;
          return (
            <BotPane key={bot.id} bot={bot} tenant={tenant} thread={threads[bot.id]} pending={pending[bot.id]}
              starters={tailored.length ? tailored : generic} tailored={tailored.length > 0} generating={generating}
              dimmed={target !== 'both' && target !== bot.id} onStarter={(s) => { setTarget(bot.id); ask(bot.id, s); }}
              onFollowUp={(q) => ask(bot.id, q)} />
          );
        })}
      </div>

      <Card className={cx('p-3', view !== 'chat' && 'hidden')}>
        <form onSubmit={(e) => { e.preventDefault(); send(); }} className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {!single && (
            <Segmented label="Send to" value={target} onChange={setTarget}
              options={[{ value: 'both', label: 'Both' }, { value: 'support', label: 'Support' }, { value: 'sales', label: 'Sales' }]} />
          )}
          <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} aria-label="Message"
            placeholder={target === 'both' ? 'Ask both bots the same question…' : `Ask the ${target === 'support' ? 'Support' : 'Sales'} Bot…`}
            className="h-10 min-w-0 flex-1 rounded-lg border border-white/10 bg-panel-2/80 px-3.5 text-sm text-fg placeholder:text-fg-3 focus:border-brand-400/60 focus:outline-none focus:ring-4 focus:ring-brand-400/10" />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={!input.trim() || busy}><IconSend className="h-4 w-4" />Send</Button>
            <Button onClick={reset} variant="ghost" disabled={!threads.support.length && !threads.sales.length}>Clear</Button>
          </div>
        </form>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 text-[11.5px] text-fg-3">
          <span>{faqs?.notice || (generating
            ? 'Writing suggested questions from your content…'
            : faqs?.status === 'ready' ? 'Suggested questions are written from your documents.' : 'Showing general starter questions.')}</span>
          <button type="button" onClick={regenerate} disabled={generating}
            className="rounded px-1 text-fg-2 underline-offset-2 transition hover:text-fg hover:underline disabled:cursor-not-allowed disabled:opacity-45">
            Refresh suggestions
          </button>
        </div>
      </Card>
    </div>
  );
}

function BotPane({ bot, tenant, thread, pending, starters, tailored, generating, dimmed, onStarter, onFollowUp }) {
  const scrollRef = useRef(null);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [thread, pending]);
  const Icon = bot.icon;
  const accent = bot.tone === 'blue' ? 'from-brand-400/20' : 'from-green-400/20';

  return (
    <Card className={cx('flex h-[480px] flex-col overflow-hidden transition', dimmed && 'opacity-60')}>
      <div className={cx('flex items-center justify-between gap-3 border-b border-white/[0.06] bg-gradient-to-r to-transparent px-4 py-3', accent)}>
        <div className="flex items-center gap-2.5">
          <span className={cx('flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-obsidian/60', bot.tone === 'blue' ? 'text-brand-300' : 'text-green-300')}>
            <Icon className="h-4 w-4" />
          </span>
          <div>
            <p className="text-sm font-semibold text-fg">{bot.name}</p>
            <p className="text-[11.5px] text-fg-3">{bot.blurb}</p>
          </div>
        </div>
        <Badge tone="success" dot>Live</Badge>
      </div>

      <div ref={scrollRef} className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4" aria-live="polite" aria-label={`${bot.name} conversation`}>
        {thread.length === 0 && !pending && (
          <div className="m-auto max-w-sm text-center">
            <p className="text-sm text-fg-2">Chat with {tenant.name}&apos;s {bot.name}.</p>
            {tailored && (
              <p className="mt-1 inline-flex items-center gap-1 text-[11.5px] text-fg-3">
                <IconSpark className="h-3.5 w-3.5" />Questions your customers are likely to ask
              </p>
            )}
            {!tailored && generating && (
              <p className="mt-1 inline-flex items-center gap-1.5 text-[11.5px] text-fg-3">
                <Spinner className="h-3.5 w-3.5" />Tailoring questions to your content…
              </p>
            )}
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              {starters.map((s) => (
                <button key={s} type="button" onClick={() => onStarter(s)}
                  className={cx('rounded-full border px-3 py-1.5 text-left text-xs transition hover:text-fg',
                    tailored
                      ? (bot.tone === 'blue' ? 'border-brand-400/25 bg-brand-400/[0.06] text-fg hover:border-brand-400/50' : 'border-green-400/25 bg-green-400/[0.06] text-fg hover:border-green-400/50')
                      : 'border-white/10 bg-white/[0.03] text-fg-2 hover:border-white/20')}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {thread.map((m, i) => (
          m.role === 'user' ? (
            <div key={i} className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-white/[0.08] px-3.5 py-2 text-sm text-fg">{m.text}</div>
          ) : (
            <div key={i} className="max-w-[92%]">
              <div className={cx('rounded-2xl rounded-bl-md border px-3.5 py-2.5 text-sm leading-relaxed',
                m.error ? 'whitespace-pre-wrap border-rose-400/25 bg-rose-500/10 text-rose-100' : 'border-white/[0.08] bg-panel-2/80 text-fg')}>
                {m.error ? m.text : <ChatText text={m.text} />}
              </div>
              {/* Rich product cards the API matched to this reply. */}
              {!m.error && m.meta?.products?.length > 0 && (
                <ProductCards products={m.meta.products} onInquire={onFollowUp} />
              )}
              {/* Chips only under the latest reply, and not while the next one is on its way. */}
              {i === thread.length - 1 && !pending && (
                <FollowUpChips questions={m.meta?.followUps} tone={bot.tone} onPick={onFollowUp} />
              )}
            </div>
          )
        ))}
        {pending && (
          <div className="flex w-fit gap-1 rounded-2xl rounded-bl-md border border-white/[0.08] bg-panel-2/80 px-3.5 py-3" aria-label="Thinking">
            {[0, 150, 300].map((d) => <span key={d} className="h-1.5 w-1.5 animate-bounce rounded-full bg-fg-3" style={{ animationDelay: `${d}ms` }} />)}
          </div>
        )}
      </div>
    </Card>
  );
}

// The Sales / Support split (GET /knowledge/distribution): for each bot,
// the document sections it may answer from — its own plus those shared with
// both. Fix a misfiled document from Documents → edit → "Used by".
// With one bot deployed it answers from every section, so that's what's listed.
function KnowledgeSplit({ data, deployed }) {
  if (data?.error) return <Card className="p-5 text-sm text-rose-200">{data.error}</Card>;
  if (!data) return <Card className="flex items-center gap-2 p-5 text-sm text-fg-3"><Spinner className="h-4 w-4" />Loading the knowledge split…</Card>;
  const single = deployed.length === 1;

  return (
    <div className={cx('grid gap-4', !single && 'lg:grid-cols-2')}>
      {BOTS.filter((b) => deployed.includes(b.id)).map((bot) => {
        const own = bot.id;
        const docs = data.documents
          .map((d) => ({ ...d, sections: d.sections.filter((s) => single || s.scope === own || s.scope === 'both') }))
          .filter((d) => d.sections.length);
        const Icon = bot.icon;
        return (
          <Card key={bot.id} className="flex max-h-[480px] flex-col overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-3">
              <span className="flex items-center gap-2 text-sm font-semibold text-fg">
                <Icon className={cx('h-4 w-4', bot.tone === 'blue' ? 'text-brand-300' : 'text-green-300')} />{bot.name}
              </span>
              <span className="text-xs text-fg-3 tabular-nums">
                {single ? `${data.totals[`${own}Bot`]} sections` : `${data.totals[`${own}Bot`]} sections · ${data.totals[own]} its own · ${data.totals.both} shared`}
              </span>
            </div>
            <ul className="flex-1 divide-y divide-white/[0.05] overflow-y-auto">
              {docs.length === 0 && <li className="p-4 text-[13px] text-amber-200">No knowledge for this bot yet — it will hand every question to your team.</li>}
              {docs.map((d) => (
                <li key={d.id} className="px-4 py-2.5">
                  <p className="truncate text-[13px] font-medium text-fg">{d.title}</p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {d.sections.map((s, i) => (
                      <Badge key={i} tone={single || s.scope === 'both' ? 'neutral' : bot.tone}>{s.title}{!single && s.scope === 'both' ? ' · shared' : ''}</Badge>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}

// Rich product cards the API matched to a reply (services/shared/productMatch.js),
// mirroring the embedded widget. "Inquire" asks the bot about that item.
function ProductThumb({ src, alt }) {
  const [ok, setOk] = useState(true);
  if (!src || !ok) return <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-white/[0.05] text-[10px] text-fg-3">—</span>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} onError={() => setOk(false)} className="h-11 w-11 shrink-0 rounded-md object-cover" />;
}

function ProductCards({ products, onInquire }) {
  if (!products?.length) return null;
  return (
    <div className="mt-2 flex flex-col gap-2" aria-label="Products">
      {products.map((p) => (
        <div key={p.sku || p.name} className="flex items-center gap-3 rounded-xl border border-white/[0.08] bg-panel-2/60 p-2.5">
          <ProductThumb src={p.imageUrl} alt={p.name} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold text-fg">{p.name}</p>
            {p.price && <p className="text-[12px] text-fg-2">{p.price}</p>}
          </div>
          {p.productUrl && /^https?:\/\//i.test(p.productUrl) ? (
            <a href={p.productUrl} target="_blank" rel="noopener noreferrer"
              className="shrink-0 rounded-lg bg-brand-400/90 px-3 py-1.5 text-[12px] font-semibold text-obsidian transition hover:bg-brand-400">
              View product
            </a>
          ) : (
            <button type="button" onClick={() => onInquire(`Tell me more about ${p.name}`)}
              className="shrink-0 rounded-lg bg-brand-400/90 px-3 py-1.5 text-[12px] font-semibold text-obsidian transition hover:bg-brand-400">
              Inquire
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// Suggested next questions from the API (services/followUps.js), the same
// ones the embedded widget shows. Clicking one asks it straight away. The
// transcript carries no scores or engine details: confidence lives on
// tickets and chat logs, cache savings on the Usage page.
function FollowUpChips({ questions, tone, onPick }) {
  if (!questions?.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5 pl-1" aria-label="Suggested follow-up questions">
      {questions.map((q) => (
        <button key={q} type="button" onClick={() => onPick(q)}
          className={cx('rounded-full border px-3 py-1 text-left text-xs text-fg-2 transition hover:text-fg',
            tone === 'blue' ? 'border-brand-400/25 bg-brand-400/[0.05] hover:border-brand-400/50' : 'border-green-400/25 bg-green-400/[0.05] hover:border-green-400/50')}>
          {q}
        </button>
      ))}
    </div>
  );
}
