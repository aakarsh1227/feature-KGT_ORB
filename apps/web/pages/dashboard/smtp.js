import { clientLayout, useSession } from '../../components/shell/DashboardShell';
import SmtpSettings from '../../components/workspace/SmtpSettings';
import { PageHeader } from '../../components/ui';

export default function SmtpPage() {
  const { ws } = useSession();
  return (
    <>
      <PageHeader title="Email settings"
        description="Send ticket alerts, lead emails and notifications from your own mail server instead of the platform default." />
      <SmtpSettings ws={ws} />
    </>
  );
}
SmtpPage.getLayout = clientLayout;
