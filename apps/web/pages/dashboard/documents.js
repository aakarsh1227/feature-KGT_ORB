import { useState } from 'react';
import { clientLayout, useSession } from '../../components/shell/DashboardShell';
import DocumentManager from '../../components/workspace/DocumentManager';
import CatalogPanel from '../../components/workspace/CatalogPanel';
import { PageHeader, Segmented } from '../../components/ui';

// Two dedicated sections: free-text knowledge (FAQs, policies, overviews,
// technical docs — organised by category inside the manager) and the
// structured product catalog (CSV → queryable rows + a document the bots
// answer from).
export default function DocumentsPage() {
  const { ws } = useSession();
  const [tab, setTab] = useState('documents');
  return (
    <>
      <PageHeader title="Knowledge" description="Everything your bots know — written knowledge and your product catalog." />
      <div className="mb-4">
        <Segmented label="Section" value={tab} onChange={setTab}
          options={[{ value: 'documents', label: 'Documents' }, { value: 'catalog', label: 'Product catalog' }]} />
      </div>
      {tab === 'documents' ? <DocumentManager ws={ws} audience="client" /> : <CatalogPanel ws={ws} />}
    </>
  );
}
DocumentsPage.getLayout = clientLayout;
