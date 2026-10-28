import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, CardHeader, Checkbox, Spinner } from '../ui';
import { useToast } from '../ui/toast';
import CatalogTable from './CatalogTable';

// Product catalog upload. A CSV with the required headers becomes structured,
// tenant-scoped rows plus a document the bots answer price/product questions
// from (apps/api/src/services/catalogIngest.js). The header validation and
// row parsing are done server-side; this surfaces the result.
const REQUIRED_HEADERS = ['Product Name', 'SKU', 'Price', 'Description'];
const TEMPLATE_CSV = 'Product Name,SKU,Price,Description,Category,Image URL,Product URL\n'
  + 'Example Widget,WID-001,$19.99,A short description of the product,Widgets,https://example.com/widget.jpg,https://store.example.com/widget\n'
  + 'Example Gadget,GAD-002,$149.00,Another product description,Gadgets,,\n';

function downloadTemplate() {
  const blob = new Blob([TEMPLATE_CSV], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'product-catalog-template.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function CatalogPanel({ ws }) {
  const toast = useToast();
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [sells, setSells] = useState(false);
  const inputRef = useRef(null);

  const load = () => ws.getCatalog().then((s) => { setSummary(s); if (s?.hasCatalog) setSells(true); }).catch((e) => toast.error(e.message)).finally(() => setLoading(false));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ws]);

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (inputRef.current) inputRef.current.value = ''; // allow re-selecting the same file
    if (!file) return;
    if (!/\.csv$/i.test(file.name)) { toast.error('Please choose a .csv file.'); return; }
    setUploading(true);
    try {
      const r = await ws.uploadCatalog(file);
      toast.success(`Imported ${r.productCount} product${r.productCount === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} row${r.skipped === 1 ? '' : 's'} skipped)` : ''}.`);
      setSummary({ hasCatalog: r.productCount > 0, productCount: r.productCount });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <Card className="p-5 sm:p-6">
      <CardHeader title="Product & course catalog"
        description="Give your bots exact product and course data so they can answer price, availability and spec questions accurately." />

      {/* Gating checkbox: businesses that sell products/courses opt in. */}
      <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <Checkbox checked={sells} onChange={(e) => setSells(e.target.checked)}>
          <span className="font-medium text-fg">Do you sell physical products, digital items, or courses?</span>
        </Checkbox>
      </div>

      {sells && (
        <>
          {/* Why-it-matters helper text, above the upload area. */}
          <div className="mt-4 rounded-xl border border-brand-400/25 bg-brand-400/[0.06] p-4 text-[13px] leading-relaxed text-fg-2">
            <p className="font-medium text-fg">What to upload</p>
            <p className="mt-1">A CSV catalog or item/course list with your <span className="font-medium">product or course names, SKUs/codes, prices and descriptions</span> (pricing sheets and course outlines work too).</p>
            <p className="mt-2 font-medium text-fg">Why it matters</p>
            <p className="mt-1">Your bots answer buying questions straight from this data — exact prices, what&apos;s included, availability — which is what turns a browsing visitor into a conversion. Without it, the bot can only talk in generalities.</p>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            {loading ? (
              <span className="inline-flex items-center gap-2 text-sm text-fg-3"><Spinner className="h-4 w-4" />Loading…</span>
            ) : (
              <Badge tone={summary?.hasCatalog ? 'success' : 'neutral'} dot>
                {summary?.hasCatalog ? `${summary.productCount} active item${summary.productCount === 1 ? '' : 's'}` : 'No items yet'}
              </Badge>
            )}
          </div>

          <div className="mt-4 rounded-xl border border-dashed border-white/15 bg-white/[0.02] p-5 text-center">
            <p className="text-sm text-fg-2">Bulk upload a catalog (.csv)</p>
            <p className="mt-1 text-[12px] text-fg-3">Required columns: {REQUIRED_HEADERS.join(', ')} (optional: Category, Image URL, Product URL)</p>
            <input ref={inputRef} type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" id="catalog-file" />
            <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
              <Button type="button" variant="primary" disabled={uploading} onClick={() => inputRef.current?.click()}>
                {uploading ? 'Uploading…' : (summary?.hasCatalog ? 'Replace via CSV' : 'Upload CSV')}
              </Button>
              <Button type="button" variant="secondary" onClick={downloadTemplate}>Download CSV template</Button>
            </div>
            <p className="mt-3 text-[11.5px] text-fg-3">A bulk upload replaces the current catalog. Rows missing a name or SKU are skipped.</p>
          </div>

          {/* Fully visible, editable catalog. */}
          <div className="mt-6">
            <CatalogTable ws={ws} onChange={load} />
          </div>
        </>
      )}
    </Card>
  );
}
