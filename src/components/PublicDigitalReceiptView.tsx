import React, { useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  Printer,
  RotateCcw,
  ShieldAlert,
} from 'lucide-react';
import { formatPHP } from '../lib/api.ts';
import {
  decodeDigitalReceiptToken,
  DigitalReceiptData,
  formatPaymentMethodLabel,
} from '../lib/digitalReceipt.ts';
import { ThemeToggle } from './ThemeToggle.tsx';

interface Props {
  token?: string | null;
  receiptData?: DigitalReceiptData | null;
  onClosePreview?: () => void;
  onExitPublicReceipt?: () => void;
}

export function PublicDigitalReceiptView({
  token,
  receiptData,
  onClosePreview,
  onExitPublicReceipt,
}: Props) {
  const [copiedSummary, setCopiedSummary] = useState(false);

  const receipt = useMemo(() => {
    if (receiptData) return receiptData;
    if (token) return decodeDigitalReceiptToken(token);
    return null;
  }, [receiptData, token]);

  if (!receipt) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 text-center space-y-4">
          <ShieldAlert className="w-8 h-8 text-red-600 dark:text-red-300 mx-auto" />
          <div className="space-y-1">
            <h1 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-50">
              Digital Receipt Unavailable
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              This receipt QR link appears incomplete or malformed. Ask the cashier to re-display the transaction QR code.
            </p>
          </div>
          {(onClosePreview || onExitPublicReceipt) && (
            <button
              type="button"
              onClick={onClosePreview || onExitPublicReceipt}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-4 py-2 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              {onClosePreview ? 'Back to POS' : 'Return to Portal'}
            </button>
          )}
        </div>
      </div>
    );
  }

  const formattedDate = receipt.soldAt
    ? new Date(receipt.soldAt).toLocaleString('en-PH', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      })
    : new Date().toLocaleString('en-PH');

  const totalPaid = receipt.payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const changeDue = Math.max(0, Math.round((totalPaid - receipt.totalAmount) * 100) / 100);

  const buildPlainTextSummary = () => {
    const lines = [
      'MAXIMUS BARBECUE',
      receipt.locationName,
      receipt.locationAddress || '',
      `Receipt #: ${receipt.receiptNumber}`,
      `Date: ${formattedDate}`,
      `Channel: ${receipt.channel.replace('_', ' ')}`,
      '----------------------------------------',
      ...receipt.items.map(
        (it) =>
          `${it.quantity}x ${it.productName}${it.variantName && it.variantName !== 'Standard' ? ` (${it.variantName})` : ''} — ${formatPHP(it.lineTotal)}`,
      ),
      ...(receipt.truncatedItemsCount
        ? [`+ ${receipt.truncatedItemsCount} additional item(s)`]
        : []),
      '----------------------------------------',
      ...(receipt.discountAmount > 0 ? [`Discount: -${formatPHP(receipt.discountAmount)}`] : []),
      `VATable Sales: ${formatPHP(receipt.subtotal)}`,
      `VAT (12%): ${formatPHP(receipt.taxAmount)}`,
      `TOTAL PAID: ${formatPHP(receipt.totalAmount)}`,
      ...receipt.payments.map(
        (p) =>
          `Paid via ${formatPaymentMethodLabel(p.method)}${p.referenceNo ? ` (${p.referenceNo})` : ''}: ${formatPHP(p.amount)}`,
      ),
      ...(changeDue > 0 ? [`Change: ${formatPHP(changeDue)}`] : []),
      'Thank you for dining with Maximus Barbecue!',
    ].filter(Boolean);
    return lines.join('\n');
  };

  const handleCopySummary = async () => {
    try {
      await navigator.clipboard.writeText(buildPlainTextSummary());
      setCopiedSummary(true);
      window.setTimeout(() => setCopiedSummary(false), 2000);
    } catch {
      // Clipboard blocked in restricted context
    }
  };

  const handleDownloadTxt = () => {
    const blob = new Blob([buildPlainTextSummary()], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${receipt.receiptNumber || 'maximus-receipt'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-slate-100 dark:bg-slate-950 py-6 px-4 sm:py-10 print:bg-white print:p-0">
      <div className="max-w-md mx-auto space-y-3">
        <div className="flex items-center justify-between gap-2 no-print">
          {onClosePreview ? (
            <button
              type="button"
              onClick={onClosePreview}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to POS Modal
            </button>
          ) : (
            <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Digital Receipt</span>
          )}
          <ThemeToggle variant="header" />
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-5 print:border-0 print:p-2">
          {/* Merchant Header */}
          <div className="text-center border-b border-dashed border-slate-300 dark:border-slate-700 pb-4 space-y-1.5">
            <img
              src="/assets/aistudio/Logo_836b4628.png"
              alt="Maximus Barbecue Logo"
              referrerPolicy="no-referrer"
              className="w-14 h-14 mx-auto rounded-full object-contain"
            />
            <h1 className="font-display text-lg font-bold text-slate-900 dark:text-slate-50">Maximus Barbecue</h1>
            <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{receipt.locationName}</p>
            {receipt.locationAddress && (
              <p className="text-[11px] text-slate-500 dark:text-slate-400 max-w-xs mx-auto">{receipt.locationAddress}</p>
            )}

            <div className="pt-2 space-y-0.5 text-xs">
              <p className="font-mono font-semibold text-slate-900 dark:text-slate-50">{receipt.receiptNumber}</p>
              <p className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                {formattedDate} · {receipt.channel.replace('_', ' ')}
              </p>
            </div>

            <div className="pt-1 flex justify-center">
              {receipt.status === 'REFUNDED' ? (
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-700 dark:text-red-300">
                  <RotateCcw className="w-3.5 h-3.5" /> REFUNDED TRANSACTION
                </span>
              ) : receipt.status === 'OFFLINE_QUEUED' ? (
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700 dark:text-amber-300">
                  <Clock className="w-3.5 h-3.5" /> ISSUED OFFLINE · SYNC PENDING
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="w-3.5 h-3.5" /> PAID DIGITAL RECEIPT
                </span>
              )}
            </div>
          </div>

          {/* Line Items */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between text-[11px] font-semibold text-slate-500 dark:text-slate-400">
              <span>Ordered Items</span>
              <span>Amount</span>
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {receipt.items.map((it, idx) => (
                <div key={idx} className="py-2 flex items-start justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-900 dark:text-slate-50">
                      <span className="font-mono font-semibold mr-1.5">{it.quantity}x</span>
                      {it.productName}
                    </p>
                    {it.variantName && it.variantName !== 'Standard' && (
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 pl-6">{it.variantName}</p>
                    )}
                  </div>
                  <span className="font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-50 shrink-0">
                    {formatPHP(it.lineTotal)}
                  </span>
                </div>
              ))}
              {receipt.truncatedItemsCount && receipt.truncatedItemsCount > 0 && (
                <p className="py-2 text-[11px] text-slate-500 dark:text-slate-400 italic">
                  + {receipt.truncatedItemsCount} additional line item(s) included in order total
                </p>
              )}
            </div>
          </div>

          {/* Totals & VAT */}
          <div className="border-t border-dashed border-slate-300 dark:border-slate-700 pt-3.5 space-y-2 text-xs">
            {receipt.discountAmount > 0 && (
              <div className="flex justify-between text-slate-600 dark:text-slate-300">
                <span>Discount Applied</span>
                <span className="font-mono tabular-nums">-{formatPHP(receipt.discountAmount)}</span>
              </div>
            )}
            <div className="flex justify-between text-slate-600 dark:text-slate-300">
              <span>VATable Sales</span>
              <span className="font-mono tabular-nums">{formatPHP(receipt.subtotal)}</span>
            </div>
            <div className="flex justify-between text-slate-600 dark:text-slate-300">
              <span>VAT (12%)</span>
              <span className="font-mono tabular-nums">{formatPHP(receipt.taxAmount)}</span>
            </div>
            <div className="flex justify-between items-baseline pt-2 border-t border-slate-100 dark:border-slate-800/80 text-base font-bold text-slate-900 dark:text-slate-50">
              <span>Total Paid</span>
              <span className="font-mono tabular-nums text-lg">{formatPHP(receipt.totalAmount)}</span>
            </div>
          </div>

          {/* Payment Tender */}
          <div className="border-t border-dashed border-slate-200 dark:border-slate-800 pt-3 space-y-1.5 text-xs">
            <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">Payment Tender</p>
            {receipt.payments.map((p, idx) => (
              <div key={idx} className="flex justify-between text-slate-700 dark:text-slate-200">
                <span>
                  {formatPaymentMethodLabel(p.method)}
                  {p.referenceNo ? ` (${p.referenceNo})` : ''}
                </span>
                <span className="font-mono tabular-nums">{formatPHP(p.amount)}</span>
              </div>
            ))}
            {changeDue > 0 && (
              <div className="flex justify-between text-slate-600 dark:text-slate-300">
                <span>Change Returned</span>
                <span className="font-mono tabular-nums">{formatPHP(changeDue)}</span>
              </div>
            )}
          </div>

          {/* Footer Message */}
          <div className="border-t border-dashed border-slate-300 dark:border-slate-700 pt-3.5 text-center space-y-1">
            <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">Thank you for dining with Maximus Barbecue!</p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">Official Customer Electronic Receipt Copy</p>
          </div>

          {/* Customer Action Strip */}
          <div className="grid grid-cols-3 gap-2 pt-1 no-print">
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-3 py-2 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white whitespace-nowrap"
            >
              <Printer className="w-3.5 h-3.5" /> Save PDF
            </button>
            <button
              type="button"
              onClick={handleDownloadTxt}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" /> Save Copy
            </button>
            <button
              type="button"
              onClick={() => void handleCopySummary()}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              {copiedSummary ? <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              {copiedSummary ? 'Copied' : 'Copy Text'}
            </button>
          </div>
        </div>

        {!onClosePreview && onExitPublicReceipt && (
          <div className="text-center no-print pt-1">
            <button
              type="button"
              onClick={onExitPublicReceipt}
              className="text-[11px] font-medium text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100 hover:underline"
            >
              Staff Portal Sign In
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
