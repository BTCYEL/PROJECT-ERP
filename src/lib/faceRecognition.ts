import * as faceapi from '@vladmandic/face-api';

const MODEL_BASE_URL = '/face-models';
let loadPromise: Promise<void> | null = null;

export async function loadFaceModels(): Promise<void> {
  if (!loadPromise) {
    loadPromise = Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_BASE_URL),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_BASE_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_BASE_URL),
    ])
      .then(() => undefined)
      .catch((err) => {
        loadPromise = null;
        throw new Error(err?.message || 'Unable to load on-device face recognition models');
      });
  }
  return loadPromise;
}

export function roundDescriptor(descriptor: Float32Array | number[]): number[] {
  return Array.from(descriptor, (v) => Math.round(Number(v) * 100000) / 100000);
}

export function parseDescriptorJson(raw: string | null | undefined): number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length === 128 && parsed.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function euclideanDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function pointDist(a: faceapi.Point, b: faceapi.Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function computeEyeAspectRatio(eye: faceapi.Point[]): number {
  if (eye.length < 6) return 0.3;
  const v1 = pointDist(eye[1], eye[5]);
  const v2 = pointDist(eye[2], eye[4]);
  const h = pointDist(eye[0], eye[3]);
  return h > 0 ? (v1 + v2) / (2 * h) : 0.3;
}

function computeHeadYawRatio(landmarks: faceapi.FaceLandmarks68): number {
  const jaw = landmarks.getJawOutline();
  const nose = landmarks.getNose();
  if (!jaw.length || !nose.length) return 0.5;
  const leftJaw = jaw[0];
  const rightJaw = jaw[jaw.length - 1];
  const noseTip = nose[3] || nose[Math.floor(nose.length / 2)];
  const span = Math.abs(rightJaw.x - leftJaw.x);
  if (span <= 1) return 0.5;
  return (noseTip.x - leftJaw.x) / span;
}

export async function extractFaceDescriptorFromDataUrl(dataUrl: string): Promise<{
  descriptor: number[];
  descriptorJson: string;
  score: number;
}> {
  await loadFaceModels();
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Could not decode crew photo for face enrollment'));
    el.src = dataUrl;
  });

  const det = await faceapi
    .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.4 }))
    .withFaceLandmarks(true)
    .withFaceDescriptor();

  if (!det) {
    throw new Error('No clear front-facing face detected in the photo. Use a well-lit front portrait.');
  }

  const descriptor = roundDescriptor(det.descriptor);
  return {
    descriptor,
    descriptorJson: JSON.stringify(descriptor),
    score: Math.round(det.detection.score * 100),
  };
}

export interface LiveFaceObservation {
  box: { x: number; y: number; width: number; height: number };
  score: number;
  eyeAspectRatio: number;
  headYawRatio: number;
  descriptor: number[];
}

export async function detectLiveFace(videoEl: HTMLVideoElement): Promise<LiveFaceObservation | null> {
  if (videoEl.readyState < 2 || videoEl.videoWidth === 0 || videoEl.videoHeight === 0) return null;
  await loadFaceModels();

  const det = await faceapi
    .detectSingleFace(videoEl, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.45 }))
    .withFaceLandmarks(true)
    .withFaceDescriptor();

  if (!det) return null;

  const leftEar = computeEyeAspectRatio(det.landmarks.getLeftEye());
  const rightEar = computeEyeAspectRatio(det.landmarks.getRightEye());

  return {
    box: {
      x: det.detection.box.x,
      y: det.detection.box.y,
      width: det.detection.box.width,
      height: det.detection.box.height,
    },
    score: det.detection.score,
    eyeAspectRatio: (leftEar + rightEar) / 2,
    headYawRatio: computeHeadYawRatio(det.landmarks),
    descriptor: roundDescriptor(det.descriptor),
  };
}

export interface FaceMatchResult<T> {
  employee: T;
  distance: number;
  confidencePct: number;
}

export function matchEmployeeFace<T extends { face_descriptor_json?: string | null; is_active?: number | boolean }>(
  descriptor: number[],
  employees: T[],
  maxDistance = 0.54,
): FaceMatchResult<T> | null {
  let best: { employee: T; distance: number } | null = null;
  for (const emp of employees) {
    if (emp.is_active === 0 || emp.is_active === false) continue;
    const stored = parseDescriptorJson(emp.face_descriptor_json);
    if (!stored) continue;
    const dist = euclideanDistance(descriptor, stored);
    if (!best || dist < best.distance) {
      best = { employee: emp, distance: dist };
    }
  }
  if (!best || best.distance > maxDistance) return null;
  const confidencePct = Math.max(55, Math.min(99, Math.round((1 - best.distance / 0.9) * 100)));
  return {
    employee: best.employee,
    distance: best.distance,
    confidencePct,
  };
}

export function captureSnapshotDataUrl(videoEl: HTMLVideoElement, maxDim = 240, mirror = true): string {
  const vw = videoEl.videoWidth || 320;
  const vh = videoEl.videoHeight || 240;
  const scale = Math.min(1, maxDim / Math.max(vw, vh));
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    if (mirror) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(videoEl, 0, 0, w, h);
  }
  return canvas.toDataURL('image/jpeg', 0.78);
}
