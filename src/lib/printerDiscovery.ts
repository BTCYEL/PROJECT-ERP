import { auth } from './firebase.ts';

export const TERMINAL_PRINTER_STORAGE_KEY = 'maximus_bbq_terminal_printer';

export type ThermalPaperWidthMm = 58 | 80;
export type PrinterConnectionType = 'NETWORK' | 'BLUETOOTH';

export interface TerminalPrinterMapping {
  connectionType: PrinterConnectionType;
  printerName: string;
  printerIp?: string;
  printerPort?: number;
  btDeviceId?: string;
  btServiceUuid?: string;
  btCharacteristicUuid?: string;
  paperWidthMm: ThermalPaperWidthMm;
  autoPrint: boolean;
  hardwareUuid?: string;
  updatedAt?: string;
}

export interface DiscoveredThermalPrinter {
  ip: string;
  port: number;
  latencyMs: number;
  escPosDetected: boolean;
  statusSummary: string;
  paperStatus: 'READY' | 'PAPER_LOW' | 'PAPER_OUT' | 'COVER_OPEN' | 'UNKNOWN';
  protocol: string;
  suggestedName: string;
}

export interface DiscoveredBluetoothPrinter {
  btDeviceId: string;
  name: string;
  connected: boolean;
  writableReady: boolean;
  btServiceUuid: string | null;
  btCharacteristicUuid: string | null;
  writeMode: 'writeWithoutResponse' | 'writeWithResponse' | 'classicOrManual';
  protocol: string;
  statusSummary: string;
}

export interface BluetoothCapabilitiesInfo {
  supported: boolean;
  available: boolean | null;
  secureContext: boolean;
  reason: string | null;
}

export interface PrinterSubnetsResponse {
  detectedSubnets: string[];
  interfaces: Array<{ name: string; address: string; cidr24: string }>;
  isCloudContainerHint: boolean;
  cloudNetworkNote: string;
}

export interface PrinterScanResponse {
  scannedHosts: number;
  durationMs: number;
  detectedSubnets: string[];
  targetDescription: string;
  printers: DiscoveredThermalPrinter[];
  cloudNetworkNote: string;
}

export interface ThermalReceiptLineItem {
  name: string;
  qty: number;
  price: number;
  lineTotal: number;
}

export interface ThermalReceiptPayload {
  businessName?: string;
  locationName?: string;
  locationAddress?: string;
  receiptNumber: string;
  soldAt?: string;
  cashierName?: string;
  customerName?: string | null;
  orderChannel?: string;
  buzzerNumber?: string | null;
  items: ThermalReceiptLineItem[];
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  totalAmount: number;
  payments?: Array<{ method: string; amount: number; reference?: string | null }>;
  shareUrl?: string;
}

//Minimal local Web Bluetooth types so tsc --noEmit works without extra @types packages
interface WebBtCharacteristic {
  uuid: string;
  properties?: {
    write?: boolean;
    writeWithoutResponse?: boolean;
    notify?: boolean;
    read?: boolean;
  };
  writeValueWithResponse?: (value: BufferSource) => Promise<void>;
  writeValueWithoutResponse?: (value: BufferSource) => Promise<void>;
  writeValue?: (value: BufferSource) => Promise<void>;
}

interface WebBtService {
  uuid: string;
  getCharacteristics: () => Promise<WebBtCharacteristic[]>;
  getCharacteristic?: (uuid: string) => Promise<WebBtCharacteristic>;
}

interface WebBtServer {
  connected: boolean;
  connect: () => Promise<WebBtServer>;
  disconnect?: () => void;
  getPrimaryServices: () => Promise<WebBtService[]>;
  getPrimaryService?: (uuid: string) => Promise<WebBtService>;
}

interface WebBtDevice {
  id: string;
  name?: string;
  gatt?: WebBtServer;
}

interface WebBluetoothApi {
  requestDevice: (options: {
    acceptAllDevices?: boolean;
    filters?: Array<{ services?: string[]; namePrefix?: string }>;
    optionalServices?: string[];
  }) => Promise<WebBtDevice>;
  getAvailability?: () => Promise<boolean>;
  getDevices?: () => Promise<WebBtDevice[]>;
}

export const THERMAL_BLE_OPTIONAL_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb', // Common ESC/POS BLE Thermal Printer service
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // ISSC / Microchip Transparent UART
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2', // Star / Generic POS BLE service
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART Service
  '0000ae30-0000-1000-8000-00805f9b34fb', // Portable thermal printer service
  '0000ff00-0000-1000-8000-00805f9b34fb', // Vendor ESC/POS BLE service
  '0000fee7-0000-1000-8000-00805f9b34fb', // Vendor thermal printer service
  '0000180a-0000-1000-8000-00805f9b34fb', // Device Information Service
];

const PREFERRED_PRINT_SERVICE_ORDER = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '0000ae30-0000-1000-8000-00805f9b34fb',
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000fee7-0000-1000-8000-00805f9b34fb',
];

const btSessionCache = new Map<
  string,
  {
    device: WebBtDevice;
    serviceUuid: string | null;
    characteristic: WebBtCharacteristic | null;
    writeMode: 'writeWithoutResponse' | 'writeWithResponse' | 'classicOrManual';
  }
>();

function getWebBluetooth(): WebBluetoothApi | null {
  if (typeof navigator === 'undefined') return null;
  const nav = navigator as Navigator & { bluetooth?: WebBluetoothApi };
  return nav.bluetooth || null;
}

export async function getBluetoothCapabilities(): Promise<BluetoothCapabilitiesInfo> {
  const secureContext = typeof window !== 'undefined' ? Boolean(window.isSecureContext) : false;
  const bt = getWebBluetooth();
  if (!bt) {
    return {
      supported: false,
      available: false,
      secureContext,
      reason: secureContext
        ? 'Web Bluetooth is unavailable in this browser or blocked by iframe policy. Use Chrome or Edge on desktop/Android, or enter a paired Bluetooth printer ID manually below.'
        : 'Bluetooth scanning requires a secure HTTPS connection.',
    };
  }
  let available: boolean | null = null;
  try {
    if (typeof bt.getAvailability === 'function') {
      available = await bt.getAvailability();
    }
  } catch {
    available = null;
  }
  return {
    supported: true,
    available,
    secureContext,
    reason:
      available === false
        ? 'No Bluetooth adapter reported by this device, or Bluetooth permission is blocked.'
        : null,
  };
}

export function isValidPrivateLanIp(raw: string): boolean {
  const ip = String(raw || '').trim();
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
  if (nums.some((n) => n < 0 || n > 255)) return false;
  const [a, b] = nums;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export function getSavedTerminalPrinterConfig(): TerminalPrinterMapping | null {
  try {
    const raw = localStorage.getItem(TERMINAL_PRINTER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const connType: PrinterConnectionType = parsed?.connectionType === 'BLUETOOTH' ? 'BLUETOOTH' : 'NETWORK';
    if (connType === 'BLUETOOTH') {
      if (!parsed?.btDeviceId && !parsed?.printerName) return null;
      return {
        connectionType: 'BLUETOOTH',
        printerName: String(parsed.printerName || 'Bluetooth Thermal Printer'),
        btDeviceId: parsed.btDeviceId ? String(parsed.btDeviceId) : undefined,
        btServiceUuid: parsed.btServiceUuid ? String(parsed.btServiceUuid) : undefined,
        btCharacteristicUuid: parsed.btCharacteristicUuid ? String(parsed.btCharacteristicUuid) : undefined,
        paperWidthMm: Number(parsed.paperWidthMm) === 58 ? 58 : 80,
        autoPrint: Boolean(parsed.autoPrint),
        hardwareUuid: parsed.hardwareUuid ? String(parsed.hardwareUuid) : undefined,
        updatedAt: parsed.updatedAt ? String(parsed.updatedAt) : undefined,
      };
    }
    if (!parsed?.printerIp || !parsed?.printerPort) return null;
    return {
      connectionType: 'NETWORK',
      printerName: String(parsed.printerName || 'Network Thermal Printer'),
      printerIp: String(parsed.printerIp),
      printerPort: Number(parsed.printerPort) || 9100,
      paperWidthMm: Number(parsed.paperWidthMm) === 58 ? 58 : 80,
      autoPrint: Boolean(parsed.autoPrint),
      hardwareUuid: parsed.hardwareUuid ? String(parsed.hardwareUuid) : undefined,
      updatedAt: parsed.updatedAt ? String(parsed.updatedAt) : undefined,
    };
  } catch {
    return null;
  }
}

export function saveTerminalPrinterConfig(config: TerminalPrinterMapping | null): void {
  try {
    if (!config) {
      localStorage.removeItem(TERMINAL_PRINTER_STORAGE_KEY);
      return;
    }
    if (config.connectionType === 'NETWORK' && !config.printerIp) {
      localStorage.removeItem(TERMINAL_PRINTER_STORAGE_KEY);
      return;
    }
    if (config.connectionType === 'BLUETOOTH' && !config.btDeviceId && !config.printerName) {
      localStorage.removeItem(TERMINAL_PRINTER_STORAGE_KEY);
      return;
    }
    localStorage.setItem(
      TERMINAL_PRINTER_STORAGE_KEY,
      JSON.stringify({
        ...config,
        updatedAt: config.updatedAt || new Date().toISOString(),
      }),
    );
  } catch {
    // ignore storage errors
  }
}

export function clearTerminalPrinterConfig(): void {
  try {
    localStorage.removeItem(TERMINAL_PRINTER_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}

export function printerMappingFromDeviceRow(
  dev: any,
  fallbackHardwareUuid?: string,
): TerminalPrinterMapping | null {
  if (!dev || dev.status === 'REVOKED') return null;
  const hwUuid = dev.hardware_uuid || fallbackHardwareUuid;
  const paperWidthMm: ThermalPaperWidthMm = Number(dev.printer_paper_width_mm) === 58 ? 58 : 80;
  const autoPrint = Boolean(dev.printer_auto_print);

  if (dev.printer_connection_type === 'BLUETOOTH' || (!dev.printer_ip && dev.printer_bt_device_id)) {
    if (!dev.printer_bt_device_id) return null;
    return {
      connectionType: 'BLUETOOTH',
      printerName: String(dev.printer_name || 'Bluetooth Thermal Printer'),
      btDeviceId: String(dev.printer_bt_device_id),
      btServiceUuid: dev.printer_bt_service_uuid ? String(dev.printer_bt_service_uuid) : undefined,
      btCharacteristicUuid: dev.printer_bt_characteristic_uuid ? String(dev.printer_bt_characteristic_uuid) : undefined,
      paperWidthMm,
      autoPrint,
      hardwareUuid: hwUuid,
    };
  }

  if (dev.printer_ip) {
    return {
      connectionType: 'NETWORK',
      printerName: String(dev.printer_name || `Thermal Printer (${dev.printer_ip})`),
      printerIp: String(dev.printer_ip),
      printerPort: Number(dev.printer_port) || 9100,
      paperWidthMm,
      autoPrint,
      hardwareUuid: hwUuid,
    };
  }

  return null;
}

// =====================================================
// BLUETOOTH ESC/POS DISCOVERY & GATT TRANSMISSION
// =====================================================

async function resolveWritableGattCharacteristic(
  device: WebBtDevice,
  preferredServiceUuid?: string | null,
  preferredCharacteristicUuid?: string | null,
): Promise<{
  serviceUuid: string | null;
  characteristic: WebBtCharacteristic | null;
  writeMode: 'writeWithoutResponse' | 'writeWithResponse' | 'classicOrManual';
}> {
  if (!device.gatt) {
    return { serviceUuid: null, characteristic: null, writeMode: 'classicOrManual' };
  }
  const server = device.gatt.connected ? device.gatt : await device.gatt.connect();

  // Fast path if we already know the exact GATT service & characteristic UUIDs
  if (preferredServiceUuid && preferredCharacteristicUuid && typeof server.getPrimaryService === 'function') {
    try {
      const svc = await server.getPrimaryService(preferredServiceUuid);
      if (typeof svc.getCharacteristic === 'function') {
        const ch = await svc.getCharacteristic(preferredCharacteristicUuid);
        const mode = ch.properties?.writeWithoutResponse
          ? 'writeWithoutResponse'
          : ch.properties?.write
            ? 'writeWithResponse'
            : null;
        if (mode) {
          return { serviceUuid: svc.uuid, characteristic: ch, writeMode: mode };
        }
      }
    } catch {
      // Fallback to full service scan below
    }
  }

  let services: WebBtService[] = [];
  try {
    services = await server.getPrimaryServices();
  } catch {
    return { serviceUuid: null, characteristic: null, writeMode: 'classicOrManual' };
  }

  const orderedServices = [...services].sort((a, b) => {
    const idxA = PREFERRED_PRINT_SERVICE_ORDER.indexOf(a.uuid.toLowerCase());
    const idxB = PREFERRED_PRINT_SERVICE_ORDER.indexOf(b.uuid.toLowerCase());
    const rankA = idxA === -1 ? 999 : idxA;
    const rankB = idxB === -1 ? 999 : idxB;
    return rankA - rankB;
  });

  for (const svc of orderedServices) {
    try {
      const chars = await svc.getCharacteristics();
      const writableNoResp = chars.find((c) => c.properties?.writeWithoutResponse);
      if (writableNoResp) {
        return { serviceUuid: svc.uuid, characteristic: writableNoResp, writeMode: 'writeWithoutResponse' };
      }
      const writableWithResp = chars.find((c) => c.properties?.write);
      if (writableWithResp) {
        return { serviceUuid: svc.uuid, characteristic: writableWithResp, writeMode: 'writeWithResponse' };
      }
    } catch {
      // Skip unreadable/protected service
    }
  }

  return { serviceUuid: null, characteristic: null, writeMode: 'classicOrManual' };
}

export async function scanAndPairBluetoothPrinter(): Promise<DiscoveredBluetoothPrinter> {
  const bt = getWebBluetooth();
  if (!bt) {
    throw new Error(
      'Web Bluetooth is not supported in this browser or context. Use Chrome/Edge on HTTPS, or enter your paired Bluetooth printer manually.',
    );
  }

  const device = await bt.requestDevice({
    acceptAllDevices: true,
    optionalServices: THERMAL_BLE_OPTIONAL_SERVICES,
  });

  const cleanName = String(device.name || '').trim() || `Bluetooth Printer (${device.id.slice(0, 8)})`;
  let connected = false;
  let serviceUuid: string | null = null;
  let characteristic: WebBtCharacteristic | null = null;
  let writeMode: 'writeWithoutResponse' | 'writeWithResponse' | 'classicOrManual' = 'classicOrManual';
  let statusSummary = 'Bluetooth device paired';

  try {
    const resolved = await resolveWritableGattCharacteristic(device);
    connected = Boolean(device.gatt?.connected);
    serviceUuid = resolved.serviceUuid;
    characteristic = resolved.characteristic;
    writeMode = resolved.writeMode;
    if (characteristic) {
      statusSummary = `GATT connected · ESC/POS writable (${writeMode === 'writeWithoutResponse' ? 'fast stream' : 'acked'})`;
    } else if (connected) {
      statusSummary = 'Connected via BLE (no writable print characteristic exposed; verify BLE SPP support)';
    }
  } catch (err: any) {
    statusSummary = err?.message
      ? `Paired, GATT connect note: ${err.message}`
      : 'Paired (connect printer power/BLE mode to verify GATT stream)';
  }

  btSessionCache.set(device.id, {
    device,
    serviceUuid,
    characteristic,
    writeMode,
  });

  return {
    btDeviceId: device.id,
    name: cleanName,
    connected,
    writableReady: Boolean(characteristic),
    btServiceUuid: serviceUuid,
    btCharacteristicUuid: characteristic?.uuid || null,
    writeMode,
    protocol: characteristic ? 'BLE GATT ESC/POS' : 'Bluetooth Paired',
    statusSummary,
  };
}

export async function listPreviouslyAuthorizedBluetoothPrinters(): Promise<DiscoveredBluetoothPrinter[]> {
  const bt = getWebBluetooth();
  if (!bt || typeof bt.getDevices !== 'function') {
    return [];
  }
  try {
    const devices = await bt.getDevices();
    return devices.map((d) => {
      const cached = btSessionCache.get(d.id);
      const isConnected = Boolean(d.gatt?.connected);
      return {
        btDeviceId: d.id,
        name: String(d.name || '').trim() || `Bluetooth Printer (${d.id.slice(0, 8)})`,
        connected: isConnected,
        writableReady: Boolean(cached?.characteristic),
        btServiceUuid: cached?.serviceUuid || null,
        btCharacteristicUuid: cached?.characteristic?.uuid || null,
        writeMode: cached?.writeMode || 'classicOrManual',
        protocol: 'BLE Paired Device',
        statusSummary: isConnected
          ? 'Previously paired & currently connected'
          : 'Previously paired in browser (tap Connect / Test to wake)',
      };
    });
  } catch {
    return [];
  }
}

export async function reconnectBluetoothPrinter(params: {
  btDeviceId?: string;
  btServiceUuid?: string;
  btCharacteristicUuid?: string;
}): Promise<DiscoveredBluetoothPrinter> {
  const bt = getWebBluetooth();
  if (!bt) {
    throw new Error('Web Bluetooth is unavailable in this browser.');
  }

  let targetDevice: WebBtDevice | undefined;
  if (params.btDeviceId) {
    const cached = btSessionCache.get(params.btDeviceId);
    if (cached?.device) {
      targetDevice = cached.device;
    } else if (typeof bt.getDevices === 'function') {
      const devices = await bt.getDevices();
      targetDevice = devices.find((d) => d.id === params.btDeviceId);
    }
  }

  if (!targetDevice) {
    // Ask browser to pick/authorize the printer cleanly on user gesture
    return scanAndPairBluetoothPrinter();
  }

  const resolved = await resolveWritableGattCharacteristic(
    targetDevice,
    params.btServiceUuid,
    params.btCharacteristicUuid,
  );
  if (!resolved.characteristic) {
    throw new Error('Connected to Bluetooth device, but no writable ESC/POS GATT characteristic was found.');
  }

  btSessionCache.set(targetDevice.id, {
    device: targetDevice,
    serviceUuid: resolved.serviceUuid,
    characteristic: resolved.characteristic,
    writeMode: resolved.writeMode,
  });

  return {
    btDeviceId: targetDevice.id,
    name: String(targetDevice.name || '').trim() || 'Bluetooth Thermal Printer',
    connected: Boolean(targetDevice.gatt?.connected),
    writableReady: true,
    btServiceUuid: resolved.serviceUuid,
    btCharacteristicUuid: resolved.characteristic.uuid,
    writeMode: resolved.writeMode,
    protocol: 'BLE GATT ESC/POS',
    statusSummary: 'Reconnected & ready for ESC/POS printing',
  };
}

function sanitizeEscPosText(input: unknown, maxLen = 80): string {
  return String(input ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/₱/g, 'PHP ')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function formatEscPosTwoCol(left: string, right: string, cols: number): string {
  const cleanL = sanitizeEscPosText(left, cols);
  const cleanR = sanitizeEscPosText(right, cols);
  const maxLeft = Math.max(4, cols - cleanR.length - 1);
  const clippedLeft = cleanL.slice(0, maxLeft);
  const spaces = Math.max(1, cols - clippedLeft.length - cleanR.length);
  return `${clippedLeft}${' '.repeat(spaces)}${cleanR}`;
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function encodeAscii(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    bytes[i] = code >= 0x20 && code <= 0x7e ? code : code === 0x0a ? 0x0a : 0x20;
  }
  return bytes;
}

export function buildClientEscPosTestBytes(params: {
  paperWidthMm: ThermalPaperWidthMm;
  printerName: string;
  btDeviceId: string;
  terminalName: string;
  hardwareUuid: string;
}): Uint8Array {
  const cols = params.paperWidthMm === 58 ? 32 : 42;
  const hr = '-'.repeat(cols);
  const chunks: Uint8Array[] = [];
  const line = (s = '') => chunks.push(encodeAscii(`${s}\n`));

  chunks.push(new Uint8Array([0x1b, 0x40])); // ESC @ Reset
  chunks.push(new Uint8Array([0x1b, 0x61, 0x01])); // Center
  chunks.push(new Uint8Array([0x1b, 0x45, 0x01])); // Bold ON
  line('MAXIMUS BARBECUE ERP');
  chunks.push(new Uint8Array([0x1b, 0x45, 0x00])); // Bold OFF
  line('BLUETOOTH PRINTER TEST SLIP');
  line(hr);
  chunks.push(new Uint8Array([0x1b, 0x61, 0x00])); // Left
  line(formatEscPosTwoCol('Printer:', params.printerName || 'Bluetooth Thermal', cols));
  line(formatEscPosTwoCol('Link:', 'Bluetooth LE (ESC/POS)', cols));
  line(`BT ID: ${sanitizeEscPosText(params.btDeviceId || 'N/A', Math.max(8, cols - 7))}`);
  line(formatEscPosTwoCol('Paper Width:', `${params.paperWidthMm}mm (${cols} cols)`, cols));
  line(formatEscPosTwoCol('Terminal:', params.terminalName || 'POS Register', cols));
  line(`UUID: ${sanitizeEscPosText(params.hardwareUuid || 'N/A', Math.max(8, cols - 6))}`);
  line(formatEscPosTwoCol('Printed:', new Date().toISOString().slice(0, 19).replace('T', ' '), cols));
  line(hr);
  chunks.push(new Uint8Array([0x1b, 0x61, 0x01])); // Center
  line('BLUETOOTH MAPPING VERIFIED');
  line('\n\n');
  chunks.push(new Uint8Array([0x1d, 0x56, 0x42, 0x0a])); // GS V 66 10 partial cut
  return concatUint8Arrays(chunks);
}

export function buildClientEscPosReceiptBytes(
  paperWidthMm: ThermalPaperWidthMm,
  receipt: ThermalReceiptPayload,
): Uint8Array {
  const cols = paperWidthMm === 58 ? 32 : 42;
  const hr = '-'.repeat(cols);
  const chunks: Uint8Array[] = [];
  const line = (s = '') => chunks.push(encodeAscii(`${s}\n`));
  const fmtMoney = (n: unknown) => `PHP ${Number(n || 0).toFixed(2)}`;

  chunks.push(new Uint8Array([0x1b, 0x40])); // ESC @
  chunks.push(new Uint8Array([0x1b, 0x61, 0x01])); // Center
  chunks.push(new Uint8Array([0x1b, 0x45, 0x01])); // Bold ON
  line(sanitizeEscPosText(receipt.businessName || 'MAXIMUS BARBECUE', cols));
  chunks.push(new Uint8Array([0x1b, 0x45, 0x00])); // Bold OFF
  if (receipt.locationName) line(sanitizeEscPosText(receipt.locationName, cols));
  if (receipt.locationAddress) line(sanitizeEscPosText(receipt.locationAddress, cols));
  line(hr);

  chunks.push(new Uint8Array([0x1b, 0x61, 0x00])); // Left
  line(formatEscPosTwoCol('Receipt:', String(receipt.receiptNumber || ''), cols));
  if (receipt.soldAt) {
    const dt = new Date(String(receipt.soldAt));
    const dtStr = Number.isNaN(dt.getTime()) ? String(receipt.soldAt) : dt.toLocaleString('en-PH');
    line(formatEscPosTwoCol('Date:', dtStr, cols));
  }
  if (receipt.cashierName) line(formatEscPosTwoCol('Cashier:', String(receipt.cashierName), cols));
  if (receipt.orderChannel) line(formatEscPosTwoCol('Channel:', String(receipt.orderChannel), cols));
  if (receipt.buzzerNumber) line(formatEscPosTwoCol('Buzzer:', `#${receipt.buzzerNumber}`, cols));
  if (receipt.customerName) line(formatEscPosTwoCol('Customer:', String(receipt.customerName), cols));
  line(hr);

  const items = Array.isArray(receipt.items) ? receipt.items : [];
  for (const it of items) {
    const qty = Number(it.qty || 0);
    line(sanitizeEscPosText(it.name || 'Item', cols));
    line(formatEscPosTwoCol(`  ${qty} x ${Number(it.price || 0).toFixed(2)}`, fmtMoney(it.lineTotal), cols));
  }
  line(hr);
  line(formatEscPosTwoCol('Subtotal:', fmtMoney(receipt.subtotal), cols));
  if (Number(receipt.discountAmount || 0) > 0) {
    line(formatEscPosTwoCol('Discount:', `-${fmtMoney(receipt.discountAmount)}`, cols));
  }
  line(formatEscPosTwoCol('VAT / Tax:', fmtMoney(receipt.taxAmount), cols));
  chunks.push(new Uint8Array([0x1b, 0x45, 0x01])); // Bold ON
  line(formatEscPosTwoCol('TOTAL DUE:', fmtMoney(receipt.totalAmount), cols));
  chunks.push(new Uint8Array([0x1b, 0x45, 0x00])); // Bold OFF

  const payments = Array.isArray(receipt.payments) ? receipt.payments : [];
  if (payments.length > 0) {
    line(hr);
    for (const p of payments) {
      line(formatEscPosTwoCol(`Paid (${String(p.method || 'CASH')}):`, fmtMoney(p.amount), cols));
    }
  }
  line(hr);
  chunks.push(new Uint8Array([0x1b, 0x61, 0x01])); // Center
  line('THANK YOU FOR DINING WITH US!');
  if (receipt.shareUrl) {
    line('Digital Receipt Available Online');
  }
  line('\n\n');
  chunks.push(new Uint8Array([0x1d, 0x56, 0x42, 0x0a])); // Feed + Partial cut
  return concatUint8Arrays(chunks);
}

async function sendBluetoothEscPosBytes(params: {
  btDeviceId?: string;
  btServiceUuid?: string;
  btCharacteristicUuid?: string;
  bytes: Uint8Array;
}): Promise<number> {
  const bt = getWebBluetooth();
  if (!bt) {
    throw new Error('Web Bluetooth is not supported in this browser. Use the browser Print dialog or switch to Chrome/Edge.');
  }
  const deviceId = String(params.btDeviceId || '').trim();
  if (!deviceId) {
    throw new Error('No Bluetooth printer device ID is mapped to this terminal.');
  }

  let cached = btSessionCache.get(deviceId);
  if (!cached || !cached.device.gatt?.connected || !cached.characteristic) {
    let device = cached?.device;
    if (!device && typeof bt.getDevices === 'function') {
      const authorizedDevices = await bt.getDevices();
      device = authorizedDevices.find((d) => d.id === deviceId);
    }
    if (!device) {
      throw new Error(
        'Bluetooth printer session is not active on this browser. Click "Reconnect Bluetooth" or pair it again in Settings -> Devices & Printers.',
      );
    }
    const resolved = await resolveWritableGattCharacteristic(
      device,
      params.btServiceUuid,
      params.btCharacteristicUuid,
    );
    if (!resolved.characteristic) {
      throw new Error('Connected to Bluetooth printer, but no writable ESC/POS characteristic was available.');
    }
    cached = {
      device,
      serviceUuid: resolved.serviceUuid,
      characteristic: resolved.characteristic,
      writeMode: resolved.writeMode,
    };
    btSessionCache.set(deviceId, cached);
  }

  const ch = cached.characteristic;
  if (!ch) {
    throw new Error('Bluetooth printer has no writable GATT characteristic.');
  }

  // Send in 20-byte MTU-safe BLE chunks with small pacing delay
  const chunkSize = 20;
  for (let offset = 0; offset < params.bytes.length; offset += chunkSize) {
    const slice = params.bytes.slice(offset, offset + chunkSize);
    if (cached.writeMode === 'writeWithoutResponse' && typeof ch.writeValueWithoutResponse === 'function') {
      await ch.writeValueWithoutResponse(slice);
    } else if (typeof ch.writeValueWithResponse === 'function') {
      await ch.writeValueWithResponse(slice);
    } else if (typeof ch.writeValue === 'function') {
      await ch.writeValue(slice);
    } else {
      throw new Error('Browser Bluetooth characteristic write API is unavailable.');
    }
    if (offset + chunkSize < params.bytes.length) {
      await new Promise((r) => setTimeout(r, 8));
    }
  }
  return params.bytes.length;
}

export async function sendBluetoothTestPrint(params: {
  btDeviceId?: string;
  btServiceUuid?: string;
  btCharacteristicUuid?: string;
  paperWidthMm: ThermalPaperWidthMm;
  printerName?: string;
  terminalName?: string;
  hardwareUuid?: string;
}): Promise<{ ok: boolean; bytesSent: number; message: string }> {
  const bytes = buildClientEscPosTestBytes({
    paperWidthMm: params.paperWidthMm,
    printerName: params.printerName || 'Bluetooth Thermal Printer',
    btDeviceId: params.btDeviceId || 'PAIRED',
    terminalName: params.terminalName || 'POS Terminal',
    hardwareUuid: params.hardwareUuid || 'N/A',
  });
  const bytesSent = await sendBluetoothEscPosBytes({
    btDeviceId: params.btDeviceId,
    btServiceUuid: params.btServiceUuid,
    btCharacteristicUuid: params.btCharacteristicUuid,
    bytes,
  });
  return {
    ok: true,
    bytesSent,
    message: `Sent ${bytesSent} ESC/POS bytes via Bluetooth to ${params.printerName || 'printer'}.`,
  };
}

export async function sendBluetoothReceiptPrint(params: {
  btDeviceId?: string;
  btServiceUuid?: string;
  btCharacteristicUuid?: string;
  printerName?: string;
  paperWidthMm: ThermalPaperWidthMm;
  receipt: ThermalReceiptPayload;
}): Promise<{ ok: boolean; bytesSent: number; message: string }> {
  const bytes = buildClientEscPosReceiptBytes(params.paperWidthMm, params.receipt);
  const bytesSent = await sendBluetoothEscPosBytes({
    btDeviceId: params.btDeviceId,
    btServiceUuid: params.btServiceUuid,
    btCharacteristicUuid: params.btCharacteristicUuid,
    bytes,
  });
  return {
    ok: true,
    bytesSent,
    message: `Printed receipt via Bluetooth to ${params.printerName || 'thermal printer'} (${bytesSent} bytes).`,
  };
}

// =====================================================
// NETWORK (LAN TCP/IP) DISCOVERY & SERVER PROXY CALLS
// =====================================================

async function authedPrinterFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Authentication required before scanning or printing.');
  }
  const idToken = await user.getIdToken();
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      Authorization: `Bearer ${idToken}`,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text || res.statusText };
  }
  if (!res.ok) {
    throw new Error(data?.error || `Printer request failed (${res.status})`);
  }
  return data as T;
}

export async function fetchDetectedPrinterSubnets(): Promise<PrinterSubnetsResponse> {
  return authedPrinterFetch<PrinterSubnetsResponse>('/printers/subnets', { method: 'GET' });
}

export async function scanNetworkThermalPrinters(params: {
  target?: string;
  ports?: number[];
}): Promise<PrinterScanResponse> {
  return authedPrinterFetch<PrinterScanResponse>('/printers/scan', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function probeSingleThermalPrinter(params: {
  ip: string;
  port: number;
}): Promise<{ reachable: boolean; printer: DiscoveredThermalPrinter | null; error?: string }> {
  return authedPrinterFetch('/printers/probe', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function sendThermalTestPrint(params: {
  ip: string;
  port: number;
  paperWidthMm: ThermalPaperWidthMm;
  printerName?: string;
  terminalName?: string;
  hardwareUuid?: string;
}): Promise<{ ok: boolean; bytesSent: number; message: string }> {
  return authedPrinterFetch('/printers/test-print', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function sendThermalReceiptPrint(params: {
  ip: string;
  port: number;
  paperWidthMm: ThermalPaperWidthMm;
  receipt: ThermalReceiptPayload;
}): Promise<{ ok: boolean; bytesSent: number; message: string }> {
  return authedPrinterFetch('/printers/print-receipt', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}
