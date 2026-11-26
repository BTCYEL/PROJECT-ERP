import React, { useState, useEffect, useMemo, useRef } from 'react';
import QRCode from 'qrcode';
import {
  Printer,
  Bluetooth,
  Wifi,
  Check,
  Copy,
  ExternalLink,
  Download,
  QrCode,
  AlertTriangle,
  RefreshCw,
  Sliders,
  CheckCircle2,
  X,
  FileText,
  Star,
  Plus,
  ArrowRight,
  ShieldCheck,
  Radio,
  Sparkles,
} from 'lucide-react';
import {
  TerminalPrinterMapping,
  ThermalPaperWidthMm,
  PrinterConnectionType,
  ThermalReceiptPayload,
  getSavedTerminalPrinterConfig,
  saveTerminalPrinterConfig,
  sendThermalReceiptPrint,
  sendBluetoothReceiptPrint,
  reconnectBluetoothPrinter,
  scanAndPairBluetoothPrinter,
  listPreviouslyAuthorizedBluetoothPrinters,
  isValidPrivateLanIp,
} from '../lib/printerDiscovery.ts';
import {
  DigitalReceiptData,
  extractDigitalReceiptFromSale,
  buildDigitalReceiptUrl,
} from '../lib/digitalReceipt.ts';
import { apiFetch, formatPHP } from '../lib/api.ts';
import { PublicDigitalReceiptView } from './PublicDigitalReceiptView.tsx';

export interface SelectablePrinterOption extends TerminalPrinterMapping {
  id: string;
  source: 'TERMINAL_DEFAULT' | 'CLOUD_REGISTER' | 'BLUETOOTH_PAIRED' | 'CUSTOM' | 'SYSTEM';
  isDefault?: boolean;
  statusText?: string;
}

export interface ReceiptPrintPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  saleData: any;
  initialPrinter?: TerminalPrinterMapping | null;
  locations?: Array<{ id: string; name: string; address?: string; truck_site?: string }>;
  currentLocationId?: string;
  onPrinterChanged?: (printer: TerminalPrinterMapping) => void;
  onPrintSuccess?: (msg: string) => void;
}

const RECENT_PRINTERS_KEY = 'maximus_bbq_recent_printers';

function loadRecentPrinters(): TerminalPrinterMapping[] {
  try {
    const raw = localStorage.getItem(RECENT_PRINTERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveRecentPrinter(printer: TerminalPrinterMapping) {
  try {
    const existing = loadRecentPrinters().filter(
      (p) =>
        !(p.connectionType === printer.connectionType &&
          (p.connectionType === 'NETWORK'
            ? p.printerIp === printer.printerIp && p.printerPort === printer.printerPort
            : p.btDeviceId === printer.btDeviceId)),
    );
    const updated = [printer, ...existing].slice(0, 5);
    localStorage.setItem(RECENT_PRINTERS_KEY, JSON.stringify(updated));
  } catch {
    // ignore
  }
}

/**
 * Format two columns for ESC/POS monospace roll simulation.
 */
function formatMonospaceColumns(left: string, right: string, cols: number): string {
  const cleanL = String(left || '').trim();
  const cleanR = String(right || '').trim();
  const maxLeft = Math.max(4, cols - cleanR.length - 1);
  const truncatedLeft = cleanL.length > maxLeft ? cleanL.slice(0, maxLeft) : cleanL;
  const spaces = Math.max(1, cols - truncatedLeft.length - cleanR.length);
  return `${truncatedLeft}${' '.repeat(spaces)}${cleanR}`;
}

export const ReceiptPrintPreviewModal: React.FC<ReceiptPrintPreviewModalProps> = ({
  isOpen,
  onClose,
  saleData,
  initialPrinter,
  locations = [],
  currentLocationId,
  onPrinterChanged,
  onPrintSuccess,
}) => {
  if (!isOpen || !saleData) return null;

  // Terminal default printer
  const savedDefault = useMemo(() => getSavedTerminalPrinterConfig(), []);

  // Available selectable printers
  const [availablePrinters, setAvailablePrinters] = useState<SelectablePrinterOption[]>([]);
  const [loadingPrinters, setLoadingPrinters] = useState(false);

  // Active selected printer
  const [selectedPrinterId, setSelectedPrinterId] = useState<string>(() => {
    if (initialPrinter) {
      return initialPrinter.connectionType === 'NETWORK'
        ? `net-${initialPrinter.printerIp}:${initialPrinter.printerPort || 9100}`
        : `bt-${initialPrinter.btDeviceId || 'dev'}`;
    }
    if (savedDefault) {
      return savedDefault.connectionType === 'NETWORK'
        ? `net-${savedDefault.printerIp}:${savedDefault.printerPort || 9100}`
        : `bt-${savedDefault.btDeviceId || 'dev'}`;
    }
    return 'system-print';
  });

  // Paper width simulation toggle (58mm vs 80mm)
  const [paperWidthMm, setPaperWidthMm] = useState<ThermalPaperWidthMm>(() => {
    return (initialPrinter?.paperWidthMm || savedDefault?.paperWidthMm || 80) as ThermalPaperWidthMm;
  });

  // Transmission & Print State
  const [printState, setPrintState] = useState<{
    busy: boolean;
    status: 'idle' | 'printing' | 'success' | 'error';
    msg?: string;
    bytesSent?: number;
    canReconnectBt?: boolean;
  }>({
    busy: false,
    status: 'idle',
  });

  // QR Code & Digital Receipt
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [copiedLink, setCopiedLink] = useState(false);
  const [previewDigitalReceipt, setPreviewDigitalReceipt] = useState<DigitalReceiptData | null>(null);

  // Quick custom printer form toggle
  const [showAddCustom, setShowAddCustom] = useState(false);
  const [customType, setCustomType] = useState<PrinterConnectionType>('NETWORK');
  const [customName, setCustomName] = useState('');
  const [customIp, setCustomIp] = useState('');
  const [customPort, setCustomPort] = useState(9100);
  const [customError, setCustomError] = useState('');

  // Paper tape scroll container ref
  const paperTapeRef = useRef<HTMLDivElement>(null);

  // Extract location and metadata
  const location = useMemo(() => {
    const locId = saleData.location_id || currentLocationId;
    return locations.find((l) => l.id === locId) || null;
  }, [saleData, currentLocationId, locations]);

  // Build customer digital receipt data
  const digitalReceipt = useMemo<DigitalReceiptData>(() => {
    return extractDigitalReceiptFromSale(saleData, location);
  }, [saleData, location]);

  const digitalReceiptUrl = useMemo<string>(() => {
    return buildDigitalReceiptUrl(digitalReceipt);
  }, [digitalReceipt]);

  // Generate QR Code data URL
  useEffect(() => {
    let active = true;
    if (digitalReceiptUrl) {
      QRCode.toDataURL(digitalReceiptUrl, {
        width: 220,
        margin: 1,
        color: { dark: '#18181b', light: '#ffffff' },
      })
        .then((url) => {
          if (active) setQrDataUrl(url);
        })
        .catch(() => {
          if (active) setQrDataUrl('');
        });
    }
    return () => {
      active = false;
    };
  }, [digitalReceiptUrl]);

  // Load and populate available printers
  useEffect(() => {
    let mounted = true;
    async function fetchPrinters() {
      setLoadingPrinters(true);
      const list: SelectablePrinterOption[] = [];

      // 1. Current Terminal Default Printer
      const def = getSavedTerminalPrinterConfig();
      if (def) {
        const id =
          def.connectionType === 'NETWORK'
            ? `net-${def.printerIp}:${def.printerPort || 9100}`
            : `bt-${def.btDeviceId || 'dev'}`;
        list.push({
          ...def,
          id,
          source: 'TERMINAL_DEFAULT',
          isDefault: true,
          statusText: 'Terminal Default Printer',
        });
      }

      // 2. Previously paired Bluetooth printers from browser
      try {
        const btPrinters = await listPreviouslyAuthorizedBluetoothPrinters();
        for (const bt of btPrinters) {
          const id = `bt-${bt.btDeviceId}`;
          if (!list.some((p) => p.id === id)) {
            list.push({
              id,
              connectionType: 'BLUETOOTH',
              printerName: bt.name,
              btDeviceId: bt.btDeviceId,
              btServiceUuid: bt.btServiceUuid || undefined,
              btCharacteristicUuid: bt.btCharacteristicUuid || undefined,
              paperWidthMm: 58,
              autoPrint: false,
              source: 'BLUETOOTH_PAIRED',
              statusText: bt.connected ? 'GATT Connected' : 'Paired in Browser',
            });
          }
        }
      } catch {
        // Bluetooth list ignored
      }

      // 3. Other registered POS registers from Firestore /settings/devices
      try {
        const res = await apiFetch<{ devices: any[] }>('/settings/devices');
        const devices = Array.isArray(res?.devices) ? res.devices : [];
        for (const d of devices) {
          if (d.status === 'AUTHORIZED') {
            if (d.printer_connection_type === 'BLUETOOTH' && d.printer_bt_device_id) {
              const id = `bt-${d.printer_bt_device_id}`;
              if (!list.some((p) => p.id === id)) {
                list.push({
                  id,
                  connectionType: 'BLUETOOTH',
                  printerName: d.printer_name || `${d.device_name} (BT)`,
                  btDeviceId: d.printer_bt_device_id,
                  btServiceUuid: d.printer_bt_service_uuid || undefined,
                  btCharacteristicUuid: d.printer_bt_characteristic_uuid || undefined,
                  paperWidthMm: Number(d.printer_paper_width_mm) === 58 ? 58 : 80,
                  autoPrint: Boolean(d.printer_auto_print),
                  source: 'CLOUD_REGISTER',
                  statusText: `Registered to ${d.device_name}`,
                });
              }
            } else if (d.printer_ip) {
              const id = `net-${d.printer_ip}:${d.printer_port || 9100}`;
              if (!list.some((p) => p.id === id)) {
                list.push({
                  id,
                  connectionType: 'NETWORK',
                  printerName: d.printer_name || `${d.device_name} (${d.printer_ip})`,
                  printerIp: d.printer_ip,
                  printerPort: Number(d.printer_port) || 9100,
                  paperWidthMm: Number(d.printer_paper_width_mm) === 58 ? 58 : 80,
                  autoPrint: Boolean(d.printer_auto_print),
                  source: 'CLOUD_REGISTER',
                  statusText: `Registered to ${d.device_name}`,
                });
              }
            }
          }
        }
      } catch {
        // Cashier may not have full settings access; try current terminal device
        try {
          const curRes = await apiFetch<{ device: any }>('/settings/devices/current');
          const dev = curRes?.device;
          if (dev && dev.status === 'AUTHORIZED') {
            if (dev.printer_connection_type === 'BLUETOOTH' && dev.printer_bt_device_id) {
              const id = `bt-${dev.printer_bt_device_id}`;
              if (!list.some((p) => p.id === id)) {
                list.push({
                  id,
                  connectionType: 'BLUETOOTH',
                  printerName: dev.printer_name || `${dev.device_name} (BT)`,
                  btDeviceId: dev.printer_bt_device_id,
                  paperWidthMm: Number(dev.printer_paper_width_mm) === 58 ? 58 : 80,
                  autoPrint: Boolean(dev.printer_auto_print),
                  source: 'CLOUD_REGISTER',
                  statusText: `Assigned Register Printer`,
                });
              }
            } else if (dev.printer_ip) {
              const id = `net-${dev.printer_ip}:${dev.printer_port || 9100}`;
              if (!list.some((p) => p.id === id)) {
                list.push({
                  id,
                  connectionType: 'NETWORK',
                  printerName: dev.printer_name || `${dev.device_name} (${dev.printer_ip})`,
                  printerIp: dev.printer_ip,
                  printerPort: Number(dev.printer_port) || 9100,
                  paperWidthMm: Number(dev.printer_paper_width_mm) === 58 ? 58 : 80,
                  autoPrint: Boolean(dev.printer_auto_print),
                  source: 'CLOUD_REGISTER',
                  statusText: `Assigned Register Printer`,
                });
              }
            }
          }
        } catch {
          // ignore
        }
      }

      // 4. Recently used printers from localStorage
      const recents = loadRecentPrinters();
      for (const rec of recents) {
        const id =
          rec.connectionType === 'NETWORK'
            ? `net-${rec.printerIp}:${rec.printerPort || 9100}`
            : `bt-${rec.btDeviceId || 'dev'}`;
        if (!list.some((p) => p.id === id)) {
          list.push({
            ...rec,
            id,
            source: 'CUSTOM',
            statusText: 'Recently Used',
          });
        }
      }

      // 5. System Browser Print / AirPrint Fallback
      list.push({
        id: 'system-print',
        connectionType: 'NETWORK', // dummy
        printerName: 'Browser System Dialog / AirPrint',
        paperWidthMm: 80,
        autoPrint: false,
        source: 'SYSTEM',
        statusText: 'Standard OS Print Dialog & PDF',
      });

      if (mounted) {
        setAvailablePrinters(list);
        setLoadingPrinters(false);

        // If current selection is not in list, auto-select first available or default
        if (!list.some((p) => p.id === selectedPrinterId)) {
          setSelectedPrinterId(list[0]?.id || 'system-print');
          if (list[0]) {
            setPaperWidthMm(list[0].paperWidthMm || 80);
          }
        }
      }
    }

    void fetchPrinters();
    return () => {
      mounted = false;
    };
  }, []);

  // Currently active printer object
  const activePrinter = useMemo<SelectablePrinterOption | null>(() => {
    return availablePrinters.find((p) => p.id === selectedPrinterId) || null;
  }, [availablePrinters, selectedPrinterId]);

  // Sync paper width when switching printer
  const handleSelectPrinter = (printer: SelectablePrinterOption) => {
    setSelectedPrinterId(printer.id);
    if (printer.source !== 'SYSTEM') {
      setPaperWidthMm(printer.paperWidthMm || 80);
    }
    setPrintState({ busy: false, status: 'idle' });
  };

  // Set selected printer as terminal default
  const handleMakeTerminalDefault = () => {
    if (!activePrinter || activePrinter.source === 'SYSTEM') return;
    const cfg: TerminalPrinterMapping = {
      connectionType: activePrinter.connectionType,
      printerName: activePrinter.printerName,
      printerIp: activePrinter.printerIp,
      printerPort: activePrinter.printerPort,
      btDeviceId: activePrinter.btDeviceId,
      btServiceUuid: activePrinter.btServiceUuid,
      btCharacteristicUuid: activePrinter.btCharacteristicUuid,
      paperWidthMm,
      autoPrint: activePrinter.autoPrint,
      updatedAt: new Date().toISOString(),
    };
    saveTerminalPrinterConfig(cfg);
    saveRecentPrinter(cfg);
    onPrinterChanged?.(cfg);
    setAvailablePrinters((prev) =>
      prev.map((p) => ({
        ...p,
        isDefault: p.id === activePrinter.id,
      })),
    );
  };

  // Quick Pair Bluetooth printer
  const handleScanAndPairBluetooth = async () => {
    setPrintState({ busy: true, status: 'printing', msg: 'Opening browser Bluetooth device selector...' });
    try {
      const discovered = await scanAndPairBluetoothPrinter();
      const newPrinter: SelectablePrinterOption = {
        id: `bt-${discovered.btDeviceId}`,
        connectionType: 'BLUETOOTH',
        printerName: discovered.name,
        btDeviceId: discovered.btDeviceId,
        btServiceUuid: discovered.btServiceUuid || undefined,
        btCharacteristicUuid: discovered.btCharacteristicUuid || undefined,
        paperWidthMm,
        autoPrint: false,
        source: 'BLUETOOTH_PAIRED',
        statusText: discovered.statusSummary,
      };

      setAvailablePrinters((prev) => [newPrinter, ...prev.filter((p) => p.id !== newPrinter.id)]);
      setSelectedPrinterId(newPrinter.id);
      saveRecentPrinter(newPrinter);
      setPrintState({
        busy: false,
        status: 'success',
        msg: `Paired Bluetooth printer: ${discovered.name}. Ready to print.`,
      });
    } catch (err: any) {
      setPrintState({
        busy: false,
        status: 'error',
        msg: err.message || 'Bluetooth pairing was cancelled or failed.',
      });
    }
  };

  // Add custom IP printer
  const handleAddCustomPrinter = (e: React.FormEvent) => {
    e.preventDefault();
    setCustomError('');
    if (customType === 'NETWORK') {
      const ip = customIp.trim();
      if (!isValidPrivateLanIp(ip)) {
        setCustomError('Please enter a valid private IPv4 address (e.g. 192.168.1.100 or 10.0.0.50).');
        return;
      }
      const port = Number(customPort) || 9100;
      const name = customName.trim() || `Thermal Printer (${ip})`;
      const id = `net-${ip}:${port}`;
      const newPrinter: SelectablePrinterOption = {
        id,
        connectionType: 'NETWORK',
        printerName: name,
        printerIp: ip,
        printerPort: port,
        paperWidthMm,
        autoPrint: false,
        source: 'CUSTOM',
        statusText: 'Custom LAN Printer',
      };
      setAvailablePrinters((prev) => [newPrinter, ...prev.filter((p) => p.id !== id)]);
      setSelectedPrinterId(id);
      saveRecentPrinter(newPrinter);
      setShowAddCustom(false);
      setCustomIp('');
      setCustomName('');
    }
  };

  // Build receipt payload
  const buildReceiptPayload = (): ThermalReceiptPayload => {
    return {
      businessName: 'MAXIMUS BARBECUE',
      locationName: saleData.location_name || location?.name || 'POS Food Truck & Grill',
      locationAddress: saleData.location_address || location?.address || '',
      receiptNumber: String(saleData.receipt_number || 'RECEIPT'),
      soldAt: saleData.sold_at || new Date().toISOString(),
      cashierName: saleData.cashier_name || 'Counter Staff',
      customerName: saleData.customer_name || null,
      orderChannel: saleData.channel || 'WALK_IN',
      buzzerNumber: saleData.buzzer_number || null,
      items: (saleData.items || []).map((it: any) => {
        const qty = Number(it.quantity || 1);
        const lineTotal = Number(it.line_total ?? it.lineTotal ?? 0);
        const vName = it.variant_name ?? it.variantName;
        const baseName = String(it.product_name ?? it.productName ?? 'Item');
        return {
          name: vName && vName !== 'Standard' ? `${baseName} (${vName})` : baseName,
          qty,
          price: qty > 0 ? lineTotal / qty : lineTotal,
          lineTotal,
        };
      }),
      subtotal: Number(saleData.subtotal ?? saleData.total_amount ?? 0),
      taxAmount: Number(saleData.tax_amount ?? 0),
      discountAmount: Number(saleData.discount_amount ?? 0),
      totalAmount: Number(saleData.total_amount ?? 0),
      payments: (saleData.payments || []).map((p: any) => ({
        method: String(p.method || 'CASH'),
        amount: Number(p.amount || 0),
        reference: p.reference_no || p.referenceNo || null,
      })),
      shareUrl: digitalReceiptUrl,
    };
  };

  // Main Execute Print Job Handler
  const handleExecutePrint = async () => {
    if (!activePrinter) return;

    // 1. Browser System Dialog
    if (activePrinter.source === 'SYSTEM') {
      window.print();
      setPrintState({
        busy: false,
        status: 'success',
        msg: 'Opened browser print dialog / system print spooler.',
      });
      onPrintSuccess?.('Opened system print dialog.');
      return;
    }

    const payload = buildReceiptPayload();
    setPrintState({
      busy: true,
      status: 'printing',
      msg:
        activePrinter.connectionType === 'BLUETOOTH'
          ? `Transmitting ESC/POS bytes via Bluetooth to ${activePrinter.printerName}...`
          : `Sending ESC/POS print job to ${activePrinter.printerIp}:${activePrinter.printerPort || 9100}...`,
    });

    try {
      if (activePrinter.connectionType === 'BLUETOOTH') {
        const res = await sendBluetoothReceiptPrint({
          btDeviceId: activePrinter.btDeviceId,
          btServiceUuid: activePrinter.btServiceUuid,
          btCharacteristicUuid: activePrinter.btCharacteristicUuid,
          printerName: activePrinter.printerName,
          paperWidthMm,
          receipt: payload,
        });

        setPrintState({
          busy: false,
          status: 'success',
          msg: res.message || `Receipt printed successfully to ${activePrinter.printerName}.`,
          bytesSent: res.bytesSent,
        });
        saveRecentPrinter(activePrinter);
        onPrintSuccess?.(res.message);
      } else {
        if (!activePrinter.printerIp) {
          throw new Error('Printer IP address is missing.');
        }
        const res = await sendThermalReceiptPrint({
          ip: activePrinter.printerIp,
          port: activePrinter.printerPort || 9100,
          paperWidthMm,
          receipt: payload,
        });

        setPrintState({
          busy: false,
          status: 'success',
          msg: res.message || `Receipt sent to ${activePrinter.printerName} (${activePrinter.printerIp}).`,
          bytesSent: res.bytesSent,
        });
        saveRecentPrinter(activePrinter);
        onPrintSuccess?.(res.message);
      }
    } catch (err: any) {
      const isBt = activePrinter.connectionType === 'BLUETOOTH';
      setPrintState({
        busy: false,
        status: 'error',
        msg:
          err.message ||
          (isBt
            ? `Could not transmit to Bluetooth printer "${activePrinter.printerName}". Ensure it is powered on and within range.`
            : `Could not reach printer at ${activePrinter.printerIp}:${activePrinter.printerPort || 9100}. Check power and LAN IP.`),
        canReconnectBt: isBt,
      });
    }
  };

  // Reconnect Bluetooth & Print
  const handleReconnectBluetoothAndPrint = async () => {
    if (!activePrinter || activePrinter.connectionType !== 'BLUETOOTH') return;
    setPrintState({ busy: true, status: 'printing', msg: 'Reconnecting Bluetooth GATT connection...' });
    try {
      const reconnected = await reconnectBluetoothPrinter({
        btDeviceId: activePrinter.btDeviceId,
        btServiceUuid: activePrinter.btServiceUuid,
        btCharacteristicUuid: activePrinter.btCharacteristicUuid,
      });

      const updated: SelectablePrinterOption = {
        ...activePrinter,
        btDeviceId: reconnected.btDeviceId,
        btServiceUuid: reconnected.btServiceUuid || activePrinter.btServiceUuid,
        btCharacteristicUuid: reconnected.btCharacteristicUuid || activePrinter.btCharacteristicUuid,
        statusText: reconnected.statusSummary,
      };

      setAvailablePrinters((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      saveRecentPrinter(updated);

      // Now print
      const payload = buildReceiptPayload();
      const res = await sendBluetoothReceiptPrint({
        btDeviceId: updated.btDeviceId,
        btServiceUuid: updated.btServiceUuid,
        btCharacteristicUuid: updated.btCharacteristicUuid,
        printerName: updated.printerName,
        paperWidthMm,
        receipt: payload,
      });

      setPrintState({
        busy: false,
        status: 'success',
        msg: res.message || `Reconnected and printed to ${updated.printerName}.`,
        bytesSent: res.bytesSent,
      });
      onPrintSuccess?.(res.message);
    } catch (err: any) {
      setPrintState({
        busy: false,
        status: 'error',
        msg: err.message || 'Could not reconnect Bluetooth printer. Try re-pairing via Scan & Pair.',
        canReconnectBt: true,
      });
    }
  };

  // Calculations for simulated paper receipt
  const receiptNumber = String(saleData.receipt_number || 'RECEIPT-0000');
  const soldAtFormatted = saleData.sold_at
    ? new Date(saleData.sold_at).toLocaleString('en-PH', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      })
    : new Date().toLocaleString('en-PH');
  const locationName = saleData.location_name || location?.name || 'Maximus Barbecue Food Truck';
  const locationAddress = saleData.location_address || location?.address || saleData.truck_site || '';
  const cashierName = saleData.cashier_name || 'Counter Cashier';
  const orderChannel = saleData.channel || 'WALK_IN';
  const buzzerNo = saleData.buzzer_number;

  const totalDue = Number(saleData.total_amount || 0);
  const discountAmt = Number(saleData.discount_amount || 0);
  const vatAmt =
    saleData.tax_amount !== undefined && saleData.tax_amount !== null
      ? Number(saleData.tax_amount)
      : Math.round((totalDue - totalDue / 1.12) * 100) / 100;
  const vatableSales =
    saleData.subtotal !== undefined && saleData.subtotal !== null
      ? Number(saleData.subtotal)
      : Math.round((totalDue + discountAmt - vatAmt) * 100) / 100;

  const payments = Array.isArray(saleData.payments) ? saleData.payments : [];
  const totalPaid = payments.reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0);
  const changeDue = Math.max(0, Math.round((totalPaid - totalDue) * 100) / 100);

  const cols = paperWidthMm === 58 ? 32 : 42;
  const divider = '-'.repeat(cols);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-3 sm:p-4 backdrop-blur-xs print:static print:bg-transparent print:p-0 print:block overflow-y-auto">
      <div className="w-full max-w-5xl max-h-[94vh] flex flex-col rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden print:max-h-none print:overflow-visible print:border-0 print:shadow-none">
        {/* Header Bar */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/80 no-print">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-orange-600/10 dark:bg-orange-500/20 text-orange-600 dark:text-orange-400 flex items-center justify-center font-bold">
              <Printer className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-display font-bold text-base text-slate-900 dark:text-slate-100">
                  Thermal Receipt Print Preview
                </h3>
                <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono font-semibold bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                  {receiptNumber}
                </span>
                {saleData.offline && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-100 dark:bg-amber-950/50 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                    Offline Queued
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Review ESC/POS roll layout and select mapped thermal printer before sending print job
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Main Body (2 Columns) */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 overflow-hidden">
          {/* Left Column: Printer Selector & Controls (5 Cols) */}
          <div className="lg:col-span-5 p-4 sm:p-5 flex flex-col gap-4 border-b lg:border-b-0 lg:border-r border-slate-200 dark:border-slate-800 overflow-y-auto max-h-[50vh] lg:max-h-[calc(94vh-130px)] no-print">
            {/* Paper Roll Width Selector */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 flex items-center justify-between">
                <span>Thermal Paper Width</span>
                <span className="text-[11px] font-normal lowercase text-slate-400">
                  {paperWidthMm === 58 ? '32 chars / row' : '42 chars / row'}
                </span>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setPaperWidthMm(58)}
                  className={`flex flex-col items-center justify-center p-2.5 rounded-xl border text-xs font-medium transition-all ${
                    paperWidthMm === 58
                      ? 'border-orange-500 bg-orange-50/70 dark:bg-orange-950/40 text-orange-900 dark:text-orange-200 font-semibold shadow-xs'
                      : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/60'
                  }`}
                >
                  <span className="font-bold text-sm">58mm (2-Inch)</span>
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">Portable / Mobile Belt</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPaperWidthMm(80)}
                  className={`flex flex-col items-center justify-center p-2.5 rounded-xl border text-xs font-medium transition-all ${
                    paperWidthMm === 80
                      ? 'border-orange-500 bg-orange-50/70 dark:bg-orange-950/40 text-orange-900 dark:text-orange-200 font-semibold shadow-xs'
                      : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/60'
                  }`}
                >
                  <span className="font-bold text-sm">80mm (3-Inch)</span>
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">Standard POS Register</span>
                </button>
              </div>
            </div>

            {/* Target Printer Selection */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Target Thermal Printer
                </label>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handleScanAndPairBluetooth}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    <Bluetooth className="w-3 h-3" /> Pair BLE
                  </button>
                  <span className="text-slate-300 dark:text-slate-700">·</span>
                  <button
                    type="button"
                    onClick={() => setShowAddCustom((v) => !v)}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:underline"
                  >
                    <Plus className="w-3 h-3" /> Custom IP
                  </button>
                </div>
              </div>

              {/* Inline Custom IP Form */}
              {showAddCustom && (
                <form
                  onSubmit={handleAddCustomPrinter}
                  className="p-3 rounded-xl border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-800/50 space-y-2.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                      Add Custom Network Printer
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowAddCustom(false)}
                      className="text-xs text-slate-400 hover:text-slate-600"
                    >
                      Cancel
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2">
                      <label className="text-[10px] font-medium text-slate-500">Printer LAN IPv4</label>
                      <input
                        type="text"
                        placeholder="192.168.1.100"
                        value={customIp}
                        onChange={(e) => setCustomIp(e.target.value)}
                        className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-mono text-slate-900 dark:text-slate-100"
                        required
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-medium text-slate-500">Port</label>
                      <input
                        type="number"
                        placeholder="9100"
                        value={customPort}
                        onChange={(e) => setCustomPort(Number(e.target.value))}
                        className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-mono text-slate-900 dark:text-slate-100"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-slate-500">Friendly Label (Optional)</label>
                    <input
                      type="text"
                      placeholder="e.g. Food Truck Window Printer"
                      value={customName}
                      onChange={(e) => setCustomName(e.target.value)}
                      className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs text-slate-900 dark:text-slate-100"
                    />
                  </div>
                  {customError && <p className="text-[11px] text-red-600 dark:text-red-400">{customError}</p>}
                  <button
                    type="submit"
                    className="w-full py-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-semibold hover:bg-slate-800"
                  >
                    Map and Select for Print
                  </button>
                </form>
              )}

              {/* Printer Options List */}
              <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                {availablePrinters.map((p) => {
                  const isSelected = p.id === selectedPrinterId;
                  const isDefault = p.isDefault || (savedDefault && savedDefault.printerName === p.printerName);
                  return (
                    <div
                      key={p.id}
                      onClick={() => handleSelectPrinter(p)}
                      className={`cursor-pointer p-3 rounded-xl border transition-all text-left flex items-start justify-between gap-3 ${
                        isSelected
                          ? 'border-orange-500 bg-orange-50/40 dark:bg-orange-950/30 ring-1 ring-orange-500/50'
                          : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-start gap-2.5">
                        <div
                          className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                            p.source === 'SYSTEM'
                              ? 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                              : p.connectionType === 'BLUETOOTH'
                                ? 'bg-blue-100 dark:bg-blue-950 text-blue-600 dark:text-blue-400'
                                : 'bg-emerald-100 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400'
                          }`}
                        >
                          {p.source === 'SYSTEM' ? (
                            <Printer className="w-3.5 h-3.5" />
                          ) : p.connectionType === 'BLUETOOTH' ? (
                            <Bluetooth className="w-3.5 h-3.5" />
                          ) : (
                            <Wifi className="w-3.5 h-3.5" />
                          )}
                        </div>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                              {p.printerName}
                            </span>
                            {isDefault && (
                              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded text-[10px] font-bold bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300">
                                <Star className="w-2.5 h-2.5 fill-current" /> Default
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                            {p.source === 'SYSTEM'
                              ? 'Native OS / AirPrint'
                              : p.connectionType === 'BLUETOOTH'
                                ? `BLE · ${p.btDeviceId?.slice(0, 10) || 'Device'}`
                                : `${p.printerIp}:${p.printerPort || 9100}`}
                          </p>
                          {p.statusText && (
                            <p className="text-[10px] text-slate-400 dark:text-slate-500">{p.statusText}</p>
                          )}
                        </div>
                      </div>
                      <div className="shrink-0 pt-0.5">
                        <div
                          className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                            isSelected
                              ? 'border-orange-500 bg-orange-500 text-white'
                              : 'border-slate-300 dark:border-slate-600'
                          }`}
                        >
                          {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Set as Default Button */}
              {activePrinter && activePrinter.source !== 'SYSTEM' && !activePrinter.isDefault && (
                <button
                  type="button"
                  onClick={handleMakeTerminalDefault}
                  className="w-full inline-flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 text-[11px] font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                >
                  <Star className="w-3 h-3 text-amber-500" /> Set {activePrinter.printerName} as Terminal Default
                </button>
              )}
            </div>

            {/* Print Status Feedback */}
            {printState.status !== 'idle' && (
              <div
                className={`p-3 rounded-xl border text-xs font-medium space-y-1 ${
                  printState.status === 'printing'
                    ? 'border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 text-blue-900 dark:text-blue-300'
                    : printState.status === 'success'
                      ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-300'
                      : 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-300'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  {printState.status === 'printing' && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                  {printState.status === 'success' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />}
                  {printState.status === 'error' && <AlertTriangle className="w-3.5 h-3.5 text-red-600" />}
                  <span>{printState.msg}</span>
                </div>
                {printState.canReconnectBt && (
                  <button
                    type="button"
                    disabled={printState.busy}
                    onClick={handleReconnectBluetoothAndPrint}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 dark:text-blue-300 hover:underline pt-1"
                  >
                    <RefreshCw className="w-3 h-3" /> Reconnect Bluetooth &amp; Retry
                  </button>
                )}
              </div>
            )}

            {/* Execution Buttons */}
            <div className="pt-2 space-y-2">
              <button
                type="button"
                disabled={printState.busy}
                onClick={handleExecutePrint}
                className="w-full inline-flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-orange-600 hover:bg-orange-700 active:bg-orange-800 text-white font-bold text-sm shadow-md hover:shadow-lg disabled:opacity-50 transition-all cursor-pointer"
              >
                {printState.busy ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Sending ESC/POS Bytes...</span>
                  </>
                ) : (
                  <>
                    <Printer className="w-4 h-4" />
                    <span>
                      Print Receipt ({activePrinter ? activePrinter.printerName : 'Selected Printer'})
                    </span>
                  </>
                )}
              </button>

              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  disabled={!digitalReceiptUrl}
                  onClick={() => {
                    if (digitalReceiptUrl) {
                      navigator.clipboard?.writeText(digitalReceiptUrl).then(() => {
                        setCopiedLink(true);
                        setTimeout(() => setCopiedLink(false), 2000);
                      });
                    }
                  }}
                  className="inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                >
                  {copiedLink ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedLink ? 'Copied' : 'Copy Link'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => setPreviewDigitalReceipt(digitalReceipt)}
                  className="inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>Customer View</span>
                </button>
              </div>
            </div>
          </div>

          {/* Right Column: True-to-life Thermal Receipt Paper Roll Preview (7 Cols) */}
          <div className="lg:col-span-7 bg-slate-100/80 dark:bg-slate-950/90 p-4 sm:p-6 flex flex-col items-center justify-start overflow-y-auto max-h-[60vh] lg:max-h-[calc(94vh-130px)]">
            {/* Visual Tape Container */}
            <div className="w-full flex flex-col items-center">
              <div className="text-center mb-3 no-print">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  ESC/POS Paperhead Emulation · {paperWidthMm}mm ({cols} Columns)
                </p>
              </div>

              {/* Physical Thermal Paper Roll Representation */}
              <div
                ref={paperTapeRef}
                style={{
                  width: paperWidthMm === 58 ? '260px' : '340px',
                }}
                className="bg-[#FCFCFA] text-[#111827] shadow-xl border border-stone-200 rounded-sm font-mono text-[11px] sm:text-xs leading-relaxed select-text p-4 pb-6 transition-all duration-200 relative print:w-full print:shadow-none print:border-0"
              >
                {/* Serrated Top Edge / Feed Guide */}
                <div className="text-center text-stone-400 text-[9px] mb-2 select-none border-b border-dashed border-stone-300 pb-1">
                  ··· ESC/POS FEED TOP ···
                </div>

                {/* Brand Header */}
                <div className="text-center space-y-1 pb-2">
                  <img
                    src="/assets/aistudio/Logo_836b4628.png"
                    alt="Logo"
                    referrerPolicy="no-referrer"
                    className="w-10 h-10 mx-auto rounded-full object-contain mb-1"
                  />
                  <h4 className="font-extrabold text-sm tracking-wide text-stone-900 uppercase">
                    MAXIMUS BARBECUE
                  </h4>
                  <p className="text-[11px] font-semibold text-stone-700">{locationName}</p>
                  {locationAddress && <p className="text-[10px] text-stone-500">{locationAddress}</p>}
                </div>

                <div className="text-stone-400 text-center select-none overflow-hidden text-[10px] my-1">
                  {divider}
                </div>

                {/* Metadata block */}
                <div className="space-y-0.5 text-[10.5px]">
                  <div className="flex justify-between">
                    <span className="text-stone-600">RECEIPT:</span>
                    <span className="font-bold">{receiptNumber}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-stone-600">DATE:</span>
                    <span>{soldAtFormatted}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-stone-600">CASHIER:</span>
                    <span>{cashierName}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-stone-600">CHANNEL:</span>
                    <span>{orderChannel}</span>
                  </div>
                  {buzzerNo && (
                    <div className="flex justify-between font-bold">
                      <span className="text-stone-600">BUZZER NO:</span>
                      <span>#{buzzerNo}</span>
                    </div>
                  )}
                  {saleData.customer_name && (
                    <div className="flex justify-between">
                      <span className="text-stone-600">CUSTOMER:</span>
                      <span>{saleData.customer_name}</span>
                    </div>
                  )}
                </div>

                <div className="text-stone-400 text-center select-none overflow-hidden text-[10px] my-1">
                  {divider}
                </div>

                {/* Line Items Table */}
                <div className="space-y-1 text-[11px]">
                  {(saleData.items || []).map((it: any, idx: number) => {
                    const qty = Number(it.quantity || 1);
                    const lineTotal = Number(it.line_total ?? it.lineTotal ?? 0);
                    const unitPrice = qty > 0 ? lineTotal / qty : lineTotal;
                    const vName = it.variant_name ?? it.variantName;
                    const baseName = String(it.product_name ?? it.productName ?? 'Item');
                    const itemName = vName && vName !== 'Standard' ? `${baseName} (${vName})` : baseName;

                    return (
                      <div key={idx} className="space-y-0.5">
                        <div className="font-semibold text-stone-900 break-words">{itemName}</div>
                        <div className="flex justify-between text-[10px] text-stone-600 pl-2">
                          <span>
                            {qty} x {unitPrice.toFixed(2)}
                          </span>
                          <span className="font-bold text-stone-900">{formatPHP(lineTotal)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="text-stone-400 text-center select-none overflow-hidden text-[10px] my-1">
                  {divider}
                </div>

                {/* Financial Summary */}
                <div className="space-y-0.5 text-[10.5px]">
                  <div className="flex justify-between">
                    <span className="text-stone-600">SUBTOTAL:</span>
                    <span>{formatPHP(vatableSales)}</span>
                  </div>
                  {discountAmt > 0 && (
                    <div className="flex justify-between text-stone-600">
                      <span>DISCOUNT:</span>
                      <span>-{formatPHP(discountAmt)}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-stone-600">VAT (12%):</span>
                    <span>{formatPHP(vatAmt)}</span>
                  </div>

                  <div className="flex justify-between text-xs font-extrabold text-stone-950 pt-1 border-t border-stone-300">
                    <span>TOTAL DUE:</span>
                    <span>{formatPHP(totalDue)}</span>
                  </div>
                </div>

                <div className="text-stone-400 text-center select-none overflow-hidden text-[10px] my-1">
                  {divider}
                </div>

                {/* Payments Section */}
                <div className="space-y-0.5 text-[10.5px]">
                  <div className="text-[10px] font-bold text-stone-500 uppercase">Payments</div>
                  {payments.length > 0 ? (
                    payments.map((p: any, idx: number) => (
                      <div key={idx} className="flex justify-between">
                        <span>
                          {p.method || 'CASH'}
                          {p.reference_no || p.referenceNo ? ` (${p.reference_no || p.referenceNo})` : ''}:
                        </span>
                        <span>{formatPHP(p.amount)}</span>
                      </div>
                    ))
                  ) : (
                    <div className="flex justify-between">
                      <span>CASH:</span>
                      <span>{formatPHP(totalDue)}</span>
                    </div>
                  )}
                  {changeDue > 0 && (
                    <div className="flex justify-between font-bold text-stone-800">
                      <span>CHANGE:</span>
                      <span>{formatPHP(changeDue)}</span>
                    </div>
                  )}
                </div>

                <div className="text-stone-400 text-center select-none overflow-hidden text-[10px] my-1">
                  {divider}
                </div>

                {/* Customer E-Receipt QR Code Embedded */}
                <div className="text-center pt-1 pb-2 space-y-1.5">
                  <p className="text-[10px] font-bold text-stone-800 tracking-wide uppercase">
                    Scan for Digital Receipt
                  </p>
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt="Digital Receipt QR"
                      className="w-28 h-28 mx-auto bg-white p-1 rounded border border-stone-300"
                    />
                  ) : (
                    <div className="w-28 h-28 mx-auto bg-stone-100 flex items-center justify-center text-[9px] text-stone-400 border border-stone-200">
                      Generating QR...
                    </div>
                  )}
                  <p className="text-[9px] text-stone-500">Official BIR Compliant Electronic Record</p>
                </div>

                {/* Footer Greeting & Partial Cut Indicator */}
                <div className="text-center pt-2 space-y-1 text-stone-600 text-[10px]">
                  <p className="font-bold text-stone-800">THANK YOU FOR DINING WITH US!</p>
                  <p className="text-[9px]">Please keep this receipt for warranty &amp; loyalty claims.</p>
                </div>

                <div className="mt-4 pt-2 border-t border-dashed border-stone-400 text-center text-stone-400 text-[9px] select-none">
                  [ === ESC/POS PAPER CUT === ]
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Modal Bottom Action Bar */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/80 no-print">
          <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
            <span>Ready for transmission via direct thermal socket / Bluetooth GATT stream.</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl border border-slate-300 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              Done / Close
            </button>
          </div>
        </div>
      </div>

      {/* Embedded Fullscreen Customer Digital Receipt Preview */}
      {previewDigitalReceipt && (
        <div className="fixed inset-0 z-[60] overflow-y-auto bg-slate-100 dark:bg-slate-950">
          <PublicDigitalReceiptView
            receiptData={previewDigitalReceipt}
            onClosePreview={() => setPreviewDigitalReceipt(null)}
          />
        </div>
      )}
    </div>
  );
};
