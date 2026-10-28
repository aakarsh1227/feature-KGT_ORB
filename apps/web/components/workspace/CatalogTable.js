import { useEffect, useRef, useState } from 'react';
import { Button, Field, Input, Spinner, Textarea, cx } from '../ui';
import { useToast } from '../ui/toast';

// The editable product/course catalog: a table of rows with full CRUD. Edits
// go straight to /catalog/products/* and the backend keeps the RAG document in
// sync, so the bots answer from the latest data.
const BLANK = { name: '', sku: '', price: '', category: '', description: '', imageUrl: '', productUrl: '' };

function Thumb({ src, alt }) {
  const [ok, setOk] = useState(true);
  if (!src || !ok) {
    return <span className="flex h-10 w-10 items-center justify-center rounded-md bg-white/[0.05] text-[10px] text-fg-3">—</span>;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} onError={() => setOk(false)} className="h-10 w-10 rounded-md object-cover" />;
}

function ProductEditor({ initial, onCancel, onSave, saving }) {
  const [form, setForm] = useState({ ...BLANK, ...initial });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const invalid = !form.name.trim() || !form.sku.trim();
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Product">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} aria-hidden="true" />
      <div className="relative w-full max-w-lg rounded-2xl border border-white/10 bg-panel p-5 shadow-2xl">
        <h3 className="text-sm font-semibold text-fg">{initial?.id ? 'Edit item' : 'Add item'}</h3>
        <div className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Product / course name" htmlFor="p-name"><Input id="p-name" value={form.name} onChange={set('name')} autoFocus /></Field>
            <Field label="SKU / code" htmlFor="p-sku"><Input id="p-sku" value={form.sku} onChange={set('sku')} /></Field>
            <Field label="Price" htmlFor="p-price" hint="Any format: $19.99, £10–£20, POA"><Input id="p-price" value={form.price} onChange={set('price')} /></Field>
            <Field label="Category" htmlFor="p-cat" hint="e.g. Electronics, Course"><Input id="p-cat" value={form.category} onChange={set('category')} /></Field>
          </div>
          <Field label="Description" htmlFor="p-desc"><Textarea id="p-desc" value={form.description} onChange={set('description')} className="min-h-[90px]" /></Field>
          <Field label="Image URL" htmlFor="p-img" hint="A link to a product/course picture (https://…)">
            <div className="flex items-center gap-3">
              <Input id="p-img" value={form.imageUrl} onChange={set('imageUrl')} placeholder="https://…" className="flex-1" />
              <Thumb src={form.imageUrl} alt="" />
            </div>
          </Field>
          <Field label="Product / purchase link" htmlFor="p-url" hint="Where the card's button sends buyers (https://…)">
            <Input id="p-url" value={form.productUrl} onChange={set('productUrl')} placeholder="https://store.example/item" />
          </Field>
        </div>
        <div className="mt-5 flex justify-end gap-3">
          <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button type="button" variant="primary" disabled={invalid || saving} onClick={() => onSave(form)}>
            {saving ? 'Saving…' : 'Save item'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function CatalogTable({ ws, onChange }) {
  const toast = useToast();
  const [products, setProducts] = useState(null);
  const [editing, setEditing] = useState(null); // product object, or {} for new, or null for closed
  const [saving, setSaving] = useState(false);
  const [confirmId, setConfirmId] = useState(null);
  const mounted = useRef(true);

  const load = () => ws.listProducts().then((r) => setProducts(r.products || [])).catch((e) => toast.error(e.message));
  useEffect(() => { mounted.current = true; load(); return () => { mounted.current = false; }; /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ws]);

  const save = async (form) => {
    setSaving(true);
    try {
      const payload = { name: form.name.trim(), sku: form.sku.trim(), price: form.price.trim(), category: form.category.trim(), description: form.description.trim(), imageUrl: form.imageUrl.trim(), productUrl: form.productUrl.trim() };
      if (editing?.id) await ws.updateProduct(editing.id, payload);
      else await ws.addProduct(payload);
      toast.success(editing?.id ? 'Item updated.' : 'Item added.');
      setEditing(null);
      await load();
      onChange?.();
    } catch (e) {
      toast.error(e.message);
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const remove = async (id) => {
    try {
      await ws.deleteProduct(id);
      setConfirmId(null);
      toast.success('Item deleted.');
      await load();
      onChange?.();
    } catch (e) {
      toast.error(e.message);
    }
  };

  if (products === null) return <div className="flex items-center gap-2 p-4 text-sm text-fg-3"><Spinner className="h-4 w-4" />Loading items…</div>;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-[13px] text-fg-3">{products.length} item{products.length === 1 ? '' : 's'} in your catalog</p>
        <Button type="button" variant="secondary" onClick={() => setEditing({})}>Add item</Button>
      </div>

      {products.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 bg-white/[0.02] p-6 text-center text-sm text-fg-3">
          No items yet. Upload a CSV above, or add one manually.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
          <table className="w-full min-w-[640px] text-left text-[13px]">
            <thead className="bg-white/[0.03] text-[11.5px] uppercase tracking-wide text-fg-3">
              <tr>
                <th className="px-3 py-2 font-medium">Image</th>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">SKU</th>
                <th className="px-3 py-2 font-medium">Price</th>
                <th className="px-3 py-2 font-medium">Category</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.05]">
              {products.map((p) => (
                <tr key={p.id} className="align-middle">
                  <td className="px-3 py-2"><Thumb src={p.imageUrl} alt={p.name} /></td>
                  <td className="px-3 py-2">
                    <span className="font-medium text-fg">{p.name}</span>
                    {p.description && <span className="block max-w-[260px] truncate text-[11.5px] text-fg-3">{p.description}</span>}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-fg-2">{p.sku}</td>
                  <td className="px-3 py-2 text-fg-2">{p.price || '—'}</td>
                  <td className="px-3 py-2 text-fg-2">{p.category || '—'}</td>
                  <td className="px-3 py-2 text-right">
                    {confirmId === p.id ? (
                      <span className="inline-flex items-center gap-2">
                        <button type="button" onClick={() => remove(p.id)} className="text-[12px] font-medium text-rose-300 hover:text-rose-200">Delete</button>
                        <button type="button" onClick={() => setConfirmId(null)} className="text-[12px] text-fg-3 hover:text-fg">Cancel</button>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-3">
                        <button type="button" onClick={() => setEditing(p)} className="text-[12px] font-medium text-fg-2 hover:text-fg">Edit</button>
                        <button type="button" onClick={() => setConfirmId(p.id)} className="text-[12px] text-fg-3 hover:text-rose-300">Delete</button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && <ProductEditor initial={editing} saving={saving} onCancel={() => setEditing(null)} onSave={save} />}
    </div>
  );
}
