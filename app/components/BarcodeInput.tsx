import { forwardRef, useEffect, useRef, useState } from "react";
import { Barcode as BarcodeIcon, Camera, X } from "lucide-react";

// Same code seen again within this window is treated as the same physical read
// (the camera keeps decoding while a barcode stays in view). Moving the item out
// of view for longer than this re-arms it, so counting several identical items
// means showing each one separately.
const CAMERA_REARM_MS = 1200;

type Props = {
  value: string;
  onChange: (v: string) => void;
  // Called on Enter (USB scanners send Enter after the code) and on each camera read.
  onCommit?: (v: string) => void;
  commitOnBlur?: boolean;
  camera?: boolean;
  autoFocus?: boolean;
  name?: string;
  placeholder?: string;
  inputClassName?: string;
};

export const BarcodeInput = forwardRef<HTMLInputElement, Props>(function BarcodeInput(
  {
    value,
    onChange,
    onCommit,
    commitOnBlur = false,
    camera = true,
    autoFocus = false,
    name,
    placeholder = "Scan or type barcode…",
    inputClassName = "",
  },
  ref
) {
  const [cameraOpen, setCameraOpen] = useState(false);

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <BarcodeIcon className="w-4 h-4 text-gray-400 shrink-0" />
        <input
          ref={ref}
          type="text"
          name={name}
          value={value}
          placeholder={placeholder}
          autoFocus={autoFocus}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCommit?.(value);
            }
          }}
          onBlur={() => commitOnBlur && onCommit?.(value)}
          className={inputClassName}
        />
        {camera && (
          <button
            type="button"
            onClick={() => setCameraOpen((o) => !o)}
            title={cameraOpen ? "Close camera" : "Scan with camera"}
            className={`shrink-0 p-2 rounded-lg border ${cameraOpen ? "border-indigo-500 text-indigo-600 dark:text-indigo-400" : "border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400"} hover:bg-gray-50 dark:hover:bg-gray-800`}
          >
            {cameraOpen ? <X size={18} /> : <Camera size={18} />}
          </button>
        )}
      </div>
      {camera && cameraOpen && (
        <CameraScanner onRead={(text) => onCommit?.(text)} onClose={() => setCameraOpen(false)} />
      )}
    </div>
  );
});

function CameraScanner({ onRead, onClose }: { onRead: (text: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;

  useEffect(() => {
    let stopped = false;
    let controls: { stop: () => void } | null = null;
    let lastText = "";
    let lastSeenAt = 0;

    (async () => {
      try {
        // Loaded on demand so the camera library never runs during SSR.
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        if (stopped || !videoRef.current) return;
        const reader = new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 150 });
        controls = await reader.decodeFromConstraints(
          { video: { facingMode: "environment" } },
          videoRef.current,
          (result) => {
            if (!result) return;
            const text = result.getText().trim();
            const now = Date.now();
            const sameRead = text === lastText && now - lastSeenAt < CAMERA_REARM_MS;
            lastText = text;
            lastSeenAt = now;
            if (!sameRead && text) onReadRef.current(text);
          }
        );
        if (stopped) controls.stop();
      } catch (err) {
        const name = err instanceof Error ? err.name : "";
        setError(
          name === "NotAllowedError"
            ? "Camera permission was denied. Allow camera access for this site in your browser settings."
            : name === "NotFoundError" || name === "OverconstrainedError"
              ? "No camera was found on this device."
              : `Could not start the camera${err instanceof Error && err.message ? `: ${err.message}` : "."}`
        );
      }
    })();

    return () => {
      stopped = true;
      controls?.stop();
    };
  }, []);

  return (
    <div className="mt-2 rounded-xl overflow-hidden border border-gray-200 dark:border-gray-700 bg-black relative">
      {error ? (
        <div className="p-4 bg-white dark:bg-gray-900 text-sm text-red-600 dark:text-red-400 flex items-start justify-between gap-3">
          <span>{error}</span>
          <button type="button" onClick={onClose} className="text-gray-500 hover:underline shrink-0">Close</button>
        </div>
      ) : (
        <>
          <video ref={videoRef} muted playsInline className="w-full max-h-72 object-cover" />
          <div className="pointer-events-none absolute inset-x-8 top-1/2 h-0.5 bg-red-500/70" />
          <p className="absolute bottom-2 inset-x-0 text-center text-xs text-white/80">
            Hold one barcode in view at a time. Move it away before scanning the same item again.
          </p>
        </>
      )}
    </div>
  );
}
