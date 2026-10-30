export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPrice: number;
  taxable?: boolean;
}

export interface Invoice {
  id: string;
  customerId: string;
  lines: InvoiceLine[];
  discountPercent?: number;
}

export function subtotal(invoice: Invoice) {
  return invoice.lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
}

export function discount(invoice: Invoice) {
  const percent = Math.min(30, Math.max(0, invoice.discountPercent ?? 0));
  return subtotal(invoice) * (percent / 100);
}

export function total(invoice: Invoice) {
  const discounted = subtotal(invoice) - discount(invoice);
  const tax = invoice.lines
    .filter((line) => line.taxable !== false)
    .reduce((sum, line) => sum + line.quantity * line.unitPrice * 0.08, 0);
  return discounted + tax;
}

export function formatInvoice(invoice: Invoice) {
  const amount = total(invoice);
  const customer = invoice.customerId.padStart(8, "0");
  return `${invoice.id} · customer ${customer} · $${amount.toFixed(2)}`;
}

export function canSend(invoice: Invoice) {
  return invoice.lines.length > 0 && total(invoice) > 0;
}

export function summarizeCustomer(invoices: Invoice[]) {
  const totalRevenue = invoices.reduce((sum, invoice) => sum + total(invoice), 0);
  const averageInvoice = invoices.length === 0 ? 0 : totalRevenue / invoices.length;
  return {
    invoiceCount: invoices.length,
    totalRevenue,
    averageInvoice,
  };
}
