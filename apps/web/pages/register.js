import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, CardHeader, Field, Input, Logo, Select, cx } from '../components/ui';
import { IconArrowLeft, IconArrowRight, IconBuilding, IconCheck, IconShield, IconSpark } from '../components/ui/icons';
import { api, setToken } from '../lib/api';
import { DOC_CATEGORIES, DEFAULT_CATEGORY } from '../lib/documentCategories';
import { DEFAULT_BOT_SCOPE } from '../lib/botScopes';
import { DEFAULT_BOT_PREFERENCE, botPreferenceLabel, botsFor } from '../lib/botPreferences';
import { putSignupHandoff } from '../lib/signupHandoff';
import AccountVerifyStep from '../components/signup/AccountVerifyStep';
import BotSelectionStep from '../components/signup/BotSelectionStep';
import KnowledgeUploadStep from '../components/signup/KnowledgeUploadStep';
import TrainingReadinessStep from '../components/signup/TrainingReadinessStep';

// Self-serve signup for a new client company, in six steps:
//   1. Account          — email + password, then the 6-digit email code on the
//                         same screen; nothing else opens until it's verified
//                         (the API refuses to create the account without it too)
//   2. Company          — company name, contact, industry
//   3. Choose bots      — Support, Sales or both (Tenant.botPreference)
//   4. Knowledge        — documents (PDF, Word, TXT, MD or a ZIP of them) and/or a
//                         website scan behind the crawl authorization, reviewed in one list
//   5. Training         — the training check runs automatically on arrival: each bot's
//                         training %, and a "path to 100%" with an upload button per
//                         requirement; new uploads re-run the check here. Continue
//                         unlocks once the check has finished (or failed) — a low
//                         score is advice, not a gate
//   6. Review & launch  — creates the isolated tenant, its first (hashed) API key and
//                         the login in one request, then lands the company, signed
//                         in, on /dashboard.

// Business category drives the tailored knowledge prompts and a tone hint for
// the bots (mirrors apps/api/src/services/shared/businessCategory.js). `asksFor`
// is shown so the user knows what to prepare.
const BUSINESS_CATEGORIES = [
  { value: 'ecommerce', label: 'E-commerce / Retail', asksFor: 'a product catalog or inventory sheet (CSV), plus returns and shipping policies' },
  { value: 'saas', label: 'SaaS / Tech', asksFor: 'product and API documentation, feature guides, and pricing tiers' },
  { value: 'healthcare', label: 'Healthcare', asksFor: 'services offered, patient FAQs, and policies' },
  { value: 'real_estate', label: 'Real Estate', asksFor: 'listings, pricing, and process/policy documents' },
  { value: 'services', label: 'Services', asksFor: 'service descriptions and terms, FAQs, and company policies' },
  { value: 'other', label: 'Other', asksFor: 'an overview, FAQs, and your key policies' }
];
const MAX_TRAINING_PAGES = 40; // mirrors MAX_PAGES_ON_COMPLETE in the API
const STEPS = ['Account', 'Company', 'Choose bots', 'Knowledge', 'Training', 'Review & launch'];
const STEP = { ACCOUNT: 0, COMPANY: 1, BOTS: 2, KNOWLEDGE: 3, TRAINING: 4, REVIEW: 5 };
const READY_AT = 80; // mirrors the API's Production Ready threshold (services/botAuditor.js)
const BOT_NAME = { support: 'Support', sales: 'Sales' };

// What the API audits and trains on, for one page.
const toApiPage = (p) => ({ title: p.title, content: p.content, category: p.category, botScope: p.botScope || DEFAULT_BOT_SCOPE, sourceUrl: p.url || undefined });
const isTrainable = (p) => !p.deleted && p.title.trim() && p.content.trim();

export default function Register() {
  const router = useRouter();
  const [step, setStep] = useState(STEP.ACCOUNT);
  const [account, setAccount] = useState({ companyName: '', contactName: '', email: '', password: '', confirm: '', industryLabel: 'Other', businessCategory: 'other' });

  // Email verification: { email, token } once the code is confirmed. Tied to
  // the address — changing the email means verifying again.
  const [verification, setVerification] = useState(null);
  const normalizedEmail = account.email.trim().toLowerCase();
  const emailVerified = !!verification && verification.email === normalizedEmail;

  // Which bots to deploy: 'support' | 'sales' | 'both'.
  const [botPreference, setBotPreference] = useState(DEFAULT_BOT_PREFERENCE);

  // One list for everything: crawled pages (url set), file sections (sourceFile) and written entries.
  const [pages, setPages] = useState([]);
  const nextId = useRef(0);
  const withIds = (list) => list.map((p) => ({ category: DEFAULT_CATEGORY, botScope: DEFAULT_BOT_SCOPE, ...p, id: nextId.current++, deleted: false }));

  const [websiteUrl, setWebsiteUrl] = useState('');
  const [consent, setConsent] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [crawl, setCrawl] = useState(null); // { crawled, skipped, baseHost, url }

  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState('');

  const trainable = pages.filter(isTrainable);
  const hasCrawled = trainable.some((p) => p.url);

  // The training check of exactly what will be trained on, for the chosen
  // bots. auditKey fingerprints pages + bots; the Training step re-runs the
  // check whenever it no longer matches (arriving with new knowledge, or an
  // upload made on that screen). failedKey stops a failed check retrying
  // itself in a loop — "Try again" is the visitor's call.
  const [audit, setAudit] = useState({ report: null, key: null, failedKey: null, loading: false, error: '' });
  const auditKey = JSON.stringify({ botPreference, pages: trainable.map(toApiPage) });
  const auditCurrent = audit.key === auditKey && !audit.loading;
  const canLaunch = emailVerified && trainable.length > 0;

  const runAudit = async () => {
    if (!trainable.length) return setAudit((a) => ({ ...a, error: 'Add a document or scan your website first — the check reads your knowledge.' }));
    const key = auditKey;
    setAudit((a) => ({ ...a, loading: true, error: '' }));
    try {
      const report = await api.preflightAudit({
        companyName: account.companyName.trim(), industryLabel: account.industryLabel, botPreference, pages: trainable.map(toApiPage)
      });
      setAudit({ report, key, failedKey: null, loading: false, error: '' });
    } catch (err) {
      // Keep the last scores on screen; say why they didn't update.
      setAudit((a) => ({ ...a, failedKey: key, loading: false, error: err.message }));
    }
  };

  // Automatic on the Training step: run when the shown report doesn't match
  // the current knowledge (and this version hasn't just failed).
  useEffect(() => {
    if (step === STEP.TRAINING && !audit.loading && audit.key !== auditKey && audit.failedKey !== auditKey && trainable.length) runAudit();
  }, [step, auditKey, audit.loading]); // eslint-disable-line react-hooks/exhaustive-deps

  const scan = async () => {
    const url = websiteUrl.trim();
    if (!consent || !url || scanning) return;
    setScanError('');
    setScanning(true);
    try {
      const data = await api.analyzeCompanyUrl(url, { authorized: consent });
      // A re-scan replaces the previous scan's pages but keeps uploads and written entries.
      setPages((prev) => [...prev.filter((p) => !p.url), ...withIds(data.pages)]);
      setCrawl({ crawled: data.crawled, skipped: data.skipped, baseHost: data.baseHost, url });
    } catch (err) {
      setScanError(err.message);
    } finally {
      setScanning(false);
    }
  };

  const addPages = (list) => setPages((prev) => [...prev, ...withIds(list)]);
  const addEntry = () => {
    const [page] = withIds([{ title: '', content: '', url: null, manual: true, autoExpand: true }]);
    setPages((prev) => [...prev, page]);
  };
  const updatePage = (id, patch) => setPages((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  const launch = async () => {
    if (launching || !canLaunch) return;
    if (!trainable.length) return setLaunchError('Add at least one website page or document with a title and content.');
    if (trainable.length > MAX_TRAINING_PAGES) return setLaunchError(`You can train on up to ${MAX_TRAINING_PAGES} entries — remove ${trainable.length - MAX_TRAINING_PAGES}.`);
    setLaunchError('');
    setLaunching(true);
    try {
      const data = await api.completeRegistration({
        companyName: account.companyName.trim(),
        contactName: account.contactName.trim(),
        email: account.email.trim(),
        password: account.password,
        industryLabel: account.industryLabel,
        businessCategory: account.businessCategory,
        botPreference,
        pages: trainable.map(toApiPage),
        // Required by the API whenever crawled pages are included; stored as the consent record.
        websiteConsent: hasCrawled ? { authorized: true, url: crawl?.url } : undefined,
        // Proof of the email OTP; the API answers 403 without it.
        emailVerificationToken: verification?.token
      });
      setToken('client', data.token);
      putSignupHandoff({ apiKey: data.apiKey, slug: data.slug, documentsCreated: data.documentsCreated });
      router.push('/dashboard');
    } catch (err) {
      setLaunching(false);
      if (err.data?.code === 'EMAIL_NOT_VERIFIED') {
        // Expired (2h) or already used: verify again from step 1.
        setVerification(null);
        setLaunchError('');
        return goTo(STEP.ACCOUNT);
      }
      setLaunchError(err.message);
    }
  };

  const goTo = (n) => {
    // Nothing past step 1 without a verified email.
    setStep(n > STEP.ACCOUNT && !emailVerified ? STEP.ACCOUNT : n);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-obsidian">
      <Head><title>Create your AI bots — KGT AI Hub</title></Head>
      <div className="bg-grid pointer-events-none absolute inset-x-0 top-0 h-[520px]" aria-hidden="true" />
      <div className="pointer-events-none absolute left-1/2 top-[-12rem] h-[26rem] w-[50rem] -translate-x-1/2 rounded-full bg-gradient-to-r from-brand-500/15 via-brand-500/10 to-green-500/20 blur-3xl" aria-hidden="true" />

      <header className="relative mx-auto flex max-w-5xl items-center justify-between px-5 py-5">
        <Link href="/" aria-label="KGT AI Hub home"><Logo /></Link>
        <Link href="/login" className="text-sm text-fg-3 hover:text-fg-2">Already a customer? <span className="font-medium text-brand-300">Sign in</span></Link>
      </header>

      <main className="relative mx-auto max-w-5xl px-5 pb-20 pt-4">
        <div className="mx-auto max-w-2xl text-center">
          <Badge tone="blue"><IconShield className="h-3 w-3" />Private to your company</Badge>
          <h1 className="mt-4 text-balance text-3xl font-semibold tracking-tight text-fg sm:text-4xl">Create your Support & Sales bots</h1>
          <p className="mt-3 text-fg-2">Trained on your website and documents, live in six steps.</p>
        </div>

        <ol className="mx-auto mb-10 mt-10 grid max-w-5xl grid-cols-3 gap-3 sm:grid-cols-6" aria-label="Progress">
          {STEPS.map((label, i) => (
            <li key={label} className="flex flex-col gap-2" aria-current={i === step ? 'step' : undefined}>
              <span className={cx('h-1 rounded-full transition-all duration-500', i <= step ? 'bg-gradient-to-r from-brand-400 to-green-400' : 'bg-white/10')} />
              <span className={cx('flex items-center gap-2 text-[13px] font-medium', i === step ? 'text-fg' : i < step ? 'text-fg-2' : 'text-fg-3')}>
                <span className={cx('flex h-5 w-5 items-center justify-center rounded-full text-[11px]', i < step ? 'bg-emerald-400/15 text-emerald-300' : i === step ? 'bg-brand-400/15 text-brand-200' : 'bg-white/5')}>
                  {i < step ? <IconCheck className="h-3 w-3" /> : i + 1}
                </span>
                <span className="truncate">{label}</span>
              </span>
            </li>
          ))}
        </ol>

        <div key={step} className="animate-fade-up">
          {step === STEP.ACCOUNT && (
            <AccountVerifyStep account={account} setAccount={setAccount} verified={emailVerified}
              onVerified={setVerification} onNext={() => goTo(STEP.COMPANY)} />
          )}
          {step === STEP.COMPANY && (
            <StepCompany account={account} setAccount={setAccount} onBack={() => goTo(STEP.ACCOUNT)} onNext={() => goTo(STEP.BOTS)} />
          )}
          {step === STEP.BOTS && (
            <BotSelectionStep value={botPreference} onChange={setBotPreference}
              onBack={() => goTo(STEP.COMPANY)} onNext={() => goTo(STEP.KNOWLEDGE)} />
          )}
          {step === STEP.KNOWLEDGE && (
            <KnowledgeUploadStep pages={pages} trainableCount={trainable.length} maxEntries={MAX_TRAINING_PAGES}
              onAddPages={addPages} updatePage={updatePage} addEntry={addEntry}
              website={{ url: websiteUrl, setUrl: setWebsiteUrl, consent, setConsent, scanning, scanError, crawl, onScan: scan }}
              onBack={() => goTo(STEP.BOTS)} onNext={() => goTo(STEP.TRAINING)} />
          )}
          {step === STEP.TRAINING && (
            <TrainingReadinessStep audit={audit} botsDeployed={botsFor(botPreference)} onAddPages={addPages} onRecheck={runAudit}
              onBack={() => goTo(STEP.KNOWLEDGE)} onNext={() => goTo(STEP.REVIEW)} />
          )}
          {step === STEP.REVIEW && (
            <StepReview account={account} botPreference={botPreference} trainable={trainable} crawledHost={hasCrawled ? crawl?.baseHost : null}
              readiness={auditCurrent ? audit.report : null} canLaunch={canLaunch} launching={launching} launchError={launchError}
              onBack={() => goTo(STEP.TRAINING)} onLaunch={launch} />
          )}
        </div>
      </main>
    </div>
  );
}

// ── Step 2
function StepCompany({ account, setAccount, onBack, onNext }) {
  const [touched, setTouched] = useState(false);
  const set = (k) => (e) => setAccount((a) => ({ ...a, [k]: e.target.value }));
  const problem = account.companyName.trim() ? '' : 'Enter your company name.';

  return (
    <form noValidate className="mx-auto max-w-lg" onSubmit={(e) => {
      e.preventDefault();
      setTouched(true);
      if (!problem) onNext();
    }}>
      <Card>
        <CardHeader icon={<IconBuilding className="h-4 w-4" />} title="About your company"
          description="Your bots introduce themselves with your company name and adapt to your industry." />
        <div className="grid gap-5 p-6">
          <Field label="Company name" htmlFor="r-company" error={touched ? problem : ''}>
            <Input id="r-company" value={account.companyName} onChange={set('companyName')} onBlur={() => setTouched(true)}
              invalid={touched && !!problem} placeholder="Acme Corporation" autoComplete="organization" autoFocus />
          </Field>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Your name" htmlFor="r-name" hint="Optional">
              <Input id="r-name" value={account.contactName} onChange={set('contactName')} placeholder="Priya Sharma" autoComplete="name" />
            </Field>
            <Field label="Business category / industry" htmlFor="r-category"
              hint={`We'll ask you to add ${(BUSINESS_CATEGORIES.find((c) => c.value === account.businessCategory) || BUSINESS_CATEGORIES[BUSINESS_CATEGORIES.length - 1]).asksFor}.`}>
              <Select id="r-category" value={account.businessCategory}
                onChange={(e) => {
                  const choice = BUSINESS_CATEGORIES.find((c) => c.value === e.target.value) || BUSINESS_CATEGORIES[BUSINESS_CATEGORIES.length - 1];
                  // One field drives both: the category key (tone/prompts) and
                  // the human industry label (the bot's role in the prompt).
                  setAccount((a) => ({ ...a, businessCategory: choice.value, industryLabel: choice.label }));
                }}>
                {BUSINESS_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </Select>
            </Field>
          </div>
        </div>
        <div className="flex flex-col-reverse gap-3 border-t border-white/[0.06] px-6 py-4 sm:flex-row sm:justify-between">
          <Button onClick={onBack}><IconArrowLeft className="h-4 w-4" />Back</Button>
          <Button type="submit" variant="primary">Continue <IconArrowRight className="h-4 w-4" /></Button>
        </div>
      </Card>
    </form>
  );
}

// ── Step 5
function StepReview({ account, botPreference, trainable, crawledHost, readiness, canLaunch, launching, launchError, onBack, onLaunch }) {
  const fromWebsite = trainable.filter((p) => p.url).length;
  const fromFiles = trainable.length - fromWebsite;
  const training = readiness?.bots
    ? botsFor(botPreference).filter((b) => readiness.bots[b]).map((b) => `${BOT_NAME[b]} ${readiness.bots[b].score}%`).join(' · ')
    : readiness ? `${readiness.readinessScore}% · ${readiness.readinessLevel}` : 'Not checked — runs after launch';
  // Advice, not a gate: launching below 80% is the company's call.
  const weak = readiness?.bots ? Object.entries(readiness.bots).filter(([, b]) => b.score < READY_AT).map(([bot]) => BOT_NAME[bot]) : [];
  return (
    <div className="mx-auto max-w-2xl">
      <Card>
        <CardHeader icon={<IconSpark className="h-4 w-4" />} title="Ready to launch"
          description="Creates your private workspace, your first API key and your login, then signs you in to your dashboard." />
        <dl className="grid gap-x-6 gap-y-4 p-6 sm:grid-cols-2">
          {[['Company', account.companyName], ['Industry', account.industryLabel], ['Sign-in email', account.email],
            ['AI agents', botPreferenceLabel(botPreference)],
            ['Knowledge', [fromWebsite && `${fromWebsite} from ${crawledHost || 'your website'}`, fromFiles && `${fromFiles} from documents`].filter(Boolean).join(' · ')],
            ['Training', training]]
            .map(([k, v]) => (
              <div key={k} className="min-w-0"><dt className="text-xs text-fg-3">{k}</dt><dd className="mt-0.5 truncate text-sm font-medium text-fg">{v}</dd></div>
            ))}
        </dl>
        <div className="grid grid-cols-3 gap-3 border-t border-white/[0.06] p-6">
          {DOC_CATEGORIES.map((c) => (
            <div key={c.id} className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-3 text-center">
              <p className="text-2xl font-semibold tabular-nums text-fg">{trainable.filter((p) => p.category === c.id).length}</p>
              <p className="truncate text-xs text-fg-3">{c.short}</p>
            </div>
          ))}
        </div>
        {weak.length > 0 && (
          <p className="mx-6 mb-4 rounded-lg border border-amber-400/20 bg-amber-400/[0.05] px-3 py-2 text-[13px] text-amber-100">
            The {weak.join(' and ')} Bot{weak.length > 1 ? 's are' : ' is'} under {READY_AT}% trained: questions it can&apos;t answer will go to your
            team. You can add documents now, or any time later from your dashboard.
          </p>
        )}
        {launchError && (
          <p className="mx-6 mb-4 rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-[13px] text-rose-100" role="alert">
            {launchError} {/already exists/i.test(launchError) && <Link href="/login" className="font-medium underline">Sign in</Link>}
          </p>
        )}
        <div className="flex flex-col-reverse gap-3 border-t border-white/[0.06] px-6 py-4 sm:flex-row sm:justify-between">
          <Button onClick={onBack} disabled={launching}><IconArrowLeft className="h-4 w-4" />Back</Button>
          <div className="flex flex-col items-stretch gap-1 sm:items-end">
            <Button variant="primary" onClick={onLaunch} loading={launching} disabled={!trainable.length || !canLaunch}>
              {launching ? `Training on ${trainable.length} entries…` : <><IconSpark className="h-4 w-4" />Deploy & test my bots</>}
            </Button>
            {!canLaunch && <span className="text-xs text-fg-3">Add at least one document or website page.</span>}
          </div>
        </div>
      </Card>
    </div>
  );
}
