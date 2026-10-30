export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPrice: number;
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
  return subtotal(invoice) * ((invoice.discountPercent ?? 0) / 100);
}

export function total(invoice: Invoice) {
  return subtotal(invoice) - discount(invoice);
}

export function formatInvoice(invoice: Invoice) {
  const amount = total(invoice);
  return `${invoice.id}: $${amount.toFixed(2)}`;
}

export function canSend(invoice: Invoice) {
  return invoice.lines.length > 0 && total(invoice) > 0;
}

export function summarizeCustomer(invoices: Invoice[]) {
  const totalRevenue = invoices.reduce((sum, invoice) => sum + total(invoice), 0);
  return {
    invoiceCount: invoices.length,
    totalRevenue,
  };
}
