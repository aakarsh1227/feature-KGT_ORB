import { useEffect, useState } from 'react';
import { Button, Card, CardHeader, Checkbox, Field, Input, Spinner, cx } from '../ui';
import { useToast } from '../ui/toast';

// Custom outbound SMTP for a tenant, with a Gmail/Outlook picker that prefills
// the server details and tailors the help text. The password is write-only:
// the API returns it masked ("********"); saving or testing with the mask
// unchanged reuses the stored password, so the real value never reaches the
// browser.
const MASK = '********';
const EMPTY = { provider: '', smtpHost: '', smtpPort: 587, smtpUser: '', smtpPass: '', smtpFrom: '', isEnabled: true };

// Provider presets. mark/color give a brand-coloured tile without shipping
// trademarked logo files.
const PROVIDERS = {
  gmail: { label: 'Gmail', mark: 'M', color: '#EA4335', host: 'smtp.gmail.com', port: 587 },
  outlook: { label: 'Outlook', mark: 'O', color: '#0078D4', host: 'smtp.office365.com', port: 587 }
};

// Step-by-step help per field. `pass` is provider-specific; the rest adapt
// their examples to the chosen provider. Each returns an array of lines.
const HELP = {
  host: {
    title: 'SMTP host',
    body: (p) => [
      'The address of your provider\'s outgoing mail server.',
      p === 'gmail' ? 'Gmail: smtp.gmail.com' : p === 'outlook' ? 'Outlook / Microsoft 365: smtp.office365.com' : 'Check your provider\'s "SMTP settings" help page.',
      'Picking a provider above fills this in for you.'
    ]
  },
  port: {
    title: 'Port — TLS vs SSL',
    body: () => [
      '587 — STARTTLS (TLS). Recommended, and the default here.',
      '465 — SSL (implicit TLS). Use only if your provider requires it.',
      'Both are encrypted; the connection is never sent in plain text.'
    ]
  },
  user: {
    title: 'Username',
    body: (p) => [
      'Almost always your full email address.',
      p === 'gmail' ? 'e.g. yourname@gmail.com (or your Google Workspace address).' : p === 'outlook' ? 'e.g. yourname@yourcompany.com (the Microsoft 365 mailbox).' : 'e.g. alerts@yourdomain.com'
    ]
  },
  pass: {
    title: 'Password / App password',
    body: (p) => {
      if (p === 'gmail') {
        return [
          'Gmail blocks your normal password for SMTP — you need a 16-character App Password:',
          '1. Go to myaccount.google.com/security and turn on 2-Step Verification.',
          '2. Open myaccount.google.com/apppasswords.',
          '3. Create an app password (name it e.g. "KGT alerts").',
          '4. Copy the 16-character code (no spaces) and paste it here as the password.'
        ];
      }
      if (p === 'outlook') {
        return [
          'Microsoft 365 / Outlook needs SMTP AUTH enabled, and an App Password if MFA is on:',
          '1. Admin: in the Microsoft 365 admin center, enable "Authenticated SMTP" for the mailbox (Users > Active users > Mail > Manage email apps).',
          '2. If the account uses MFA, create an App Password at account.microsoft.com (Security > Advanced security options > App passwords).',
          '3. Paste that app password here. If SMTP AUTH is off tenant-wide, an admin must turn it on first.'
        ];
      }
      return [
        'Use the password your provider accepts for SMTP.',
        'If the mailbox uses two-factor authentication, generate an "app password" rather than your normal one.'
      ];
    }
  },
  from: {
    title: 'From address',
    body: () => [
      'The sender recipients see, e.g. "Acme Support <support@acme.com>".',
      'It must be an address this mailbox is allowed to send as, or the provider will reject the email.'
    ]
  }
};

function HelpButton({ topic, onOpen }) {
  return (
    <button type="button" onClick={() => onOpen(topic)} aria-label={`Help: ${HELP[topic].title}`}
      className="ml-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full border border-white/20 text-[10px] font-semibold text-fg-3 align-middle transition hover:border-brand-400/60 hover:text-fg">
      ?
    </button>
  );
}

function HelpModal({ topic, provider, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!topic) return null;
  const help = HELP[topic];
  const lines = help.body(provider);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={help.title}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-md rounded-2xl border border-white/10 bg-panel p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <h3 className="text-sm font-semibold text-fg">{help.title}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-fg-3 hover:bg-white/[0.06] hover:text-fg">✕</button>
        </div>
        <ul className="mt-3 space-y-2 text-[13px] leading-relaxed text-fg-2">
          {lines.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      </div>
    </div>
  );
}

export default function SmtpSettings({ ws }) {
  const toast = useToast();
  const [form, setForm] = useState(EMPTY);
  const [hasPassword, setHasPassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [helpTopic, setHelpTopic] = useState(null);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  // Picking a provider sets its type and fills in host/port, leaving the
  // credentials the user already typed in place.
  const chooseProvider = (id) => setForm((f) => ({ ...f, provider: id, smtpHost: PROVIDERS[id].host, smtpPort: PROVIDERS[id].port }));

  useEffect(() => {
    let alive = true;
    ws.getSmtpConfig()
      .then((cfg) => {
        if (!alive) return;
        setHasPassword(!!cfg.hasPassword);
        setForm({
          provider: cfg.provider || '', smtpHost: cfg.smtpHost || '', smtpPort: cfg.smtpPort ?? 587, smtpUser: cfg.smtpUser || '',
          smtpPass: cfg.smtpPass || '', smtpFrom: cfg.smtpFrom || '',
          isEnabled: cfg.configured ? !!cfg.isEnabled : true
        });
      })
      .catch((e) => toast.error(e.message))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [ws]);

  const payload = () => ({
    provider: form.provider || '',
    smtpHost: form.smtpHost.trim(),
    smtpPort: Number(form.smtpPort),
    smtpUser: form.smtpUser.trim(),
    smtpPass: form.smtpPass,
    smtpFrom: form.smtpFrom.trim(),
    isEnabled: form.isEnabled
  });

  const incomplete = !form.smtpHost.trim() || !form.smtpUser.trim() || !form.smtpFrom.trim() || !form.smtpPort
    || !(form.smtpPass || hasPassword);

  const test = async () => {
    setTesting(true);
    try {
      const r = await ws.testSmtpConfig(payload());
      if (r.ok) toast.success('Connection succeeded — these credentials work.');
      else toast.error(`Connection failed${r.error ? `: ${r.error}` : ''}.${r.hint ? ` ${r.hint}` : ''}`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setTesting(false);
    }
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const cfg = await ws.saveSmtpConfig(payload());
      setHasPassword(!!cfg.hasPassword);
      setForm((f) => ({ ...f, smtpPass: cfg.smtpPass || '' })); // now masked
      setShowPass(false);
      toast.success('Email settings saved.');
    } catch (e2) {
      toast.error(e2.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <Card className="flex items-center gap-2 p-6 text-sm text-fg-3"><Spinner className="h-4 w-4" />Loading email settings…</Card>;
  }

  // A field label with a help "?" next to it.
  const labelWithHelp = (text, topic) => (
    <span className="inline-flex items-center">{text}<HelpButton topic={topic} onOpen={setHelpTopic} /></span>
  );
  const providerName = PROVIDERS[form.provider]?.label;

  return (
    <Card as="form" onSubmit={save} className="p-5 sm:p-6">
      <CardHeader title="Email settings"
        description="Send ticket alerts, lead emails and notifications from your own mailbox. Leave this off to use the platform default." />

      <div className="mt-4">
        <Checkbox checked={form.isEnabled} onChange={(e) => setForm((f) => ({ ...f, isEnabled: e.target.checked }))}>
          Use my own email account
        </Checkbox>
      </div>

      <fieldset disabled={!form.isEnabled} className={cx('mt-5 transition', !form.isEnabled && 'opacity-50')}>
        {/* Provider picker */}
        <p className="text-[13px] font-medium text-fg-2">Choose your email provider</p>
        <div className="mt-2 grid grid-cols-2 gap-3 sm:max-w-md">
          {Object.entries(PROVIDERS).map(([id, p]) => {
            const active = form.provider === id;
            return (
              <button key={id} type="button" onClick={() => chooseProvider(id)} aria-pressed={active}
                className={cx('flex items-center gap-3 rounded-xl border p-3 text-left transition',
                  active ? 'border-brand-400/70 bg-brand-400/[0.08]' : 'border-white/10 bg-white/[0.02] hover:border-white/25')}>
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white" style={{ backgroundColor: p.color }}>{p.mark}</span>
                <span>
                  <span className="block text-sm font-semibold text-fg">{p.label}</span>
                  <span className="block text-[11.5px] text-fg-3">{p.host}</span>
                </span>
              </button>
            );
          })}
        </div>
        {providerName && (
          <p className="mt-2 text-[12px] text-fg-3">
            {providerName} selected — host and port are filled in. Use the <span className="font-semibold">?</span> next to each field for step-by-step help getting your {providerName} app password.
          </p>
        )}

        <div className="mt-5 space-y-4">
          <div className="grid gap-4 sm:grid-cols-[1fr,150px]">
            <Field label={labelWithHelp('SMTP host', 'host')} htmlFor="smtpHost">
              <Input id="smtpHost" value={form.smtpHost} onChange={set('smtpHost')} placeholder="smtp.yourdomain.com" autoComplete="off" />
            </Field>
            <Field label={labelWithHelp('Port', 'port')} htmlFor="smtpPort">
              <Input id="smtpPort" type="number" min={1} max={65535} value={form.smtpPort} onChange={set('smtpPort')} />
            </Field>
          </div>

          <Field label={labelWithHelp('Username', 'user')} htmlFor="smtpUser" hint="Usually the full email address">
            <Input id="smtpUser" value={form.smtpUser} onChange={set('smtpUser')} placeholder="alerts@yourdomain.com" autoComplete="off" />
          </Field>

          <Field label={labelWithHelp('Password', 'pass')} htmlFor="smtpPass"
            hint={hasPassword ? 'A password is saved. Leave this unchanged to keep it, or type a new one to replace it.'
              : form.provider === 'gmail' ? 'Gmail needs a 16-character App Password — click the ? for steps.'
              : form.provider === 'outlook' ? 'Microsoft 365 needs SMTP AUTH (and an app password if MFA is on) — click the ? for steps.'
              : 'An app password if the mailbox uses MFA.'}>
            <div className="relative">
              <Input id="smtpPass" type={showPass ? 'text' : 'password'} value={form.smtpPass} onChange={set('smtpPass')}
                placeholder={hasPassword ? MASK : 'Enter password'} autoComplete="new-password" className="pr-16" />
              <button type="button" onClick={() => setShowPass((s) => !s)}
                className="absolute inset-y-0 right-0 px-3 text-[12px] font-medium text-fg-3 hover:text-fg"
                aria-label={showPass ? 'Hide password' : 'Show password'}>
                {showPass ? 'Hide' : 'Show'}
              </button>
            </div>
          </Field>

          <Field label={labelWithHelp('From address', 'from')} htmlFor="smtpFrom"
            hint={'The sender shown to recipients, e.g. "Acme Support <support@acme.com>".'}>
            <Input id="smtpFrom" value={form.smtpFrom} onChange={set('smtpFrom')} placeholder="support@yourdomain.com" autoComplete="off" />
          </Field>
        </div>
      </fieldset>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={saving || (form.isEnabled && incomplete)}>
          {saving ? 'Saving…' : 'Save configuration'}
        </Button>
        <Button type="button" variant="secondary" onClick={test} disabled={!form.isEnabled || testing || incomplete}>
          {testing ? 'Testing…' : 'Test connection'}
        </Button>
        <span className="text-[12px] text-fg-3">Your password is encrypted before it is stored and is never shown again.</span>
      </div>

      <HelpModal topic={helpTopic} provider={form.provider} onClose={() => setHelpTopic(null)} />
    </Card>
  );
}
