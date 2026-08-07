import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function mks(size: number) {
  return { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;
}

export function PhoneIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.08 4.18 2 2 0 0 1 4.08 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>;
}

export function MessageIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>;
}

export function FaxIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><path d="M6 16.5V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-3"/><path d="M14 17h.01"/><path d="M6 2h8l6 6v4"/><path d="M2 9v6h4"/><path d="M6 9v6"/></svg>;
}

export function MailIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a2 2 0 0 1-2.06 0L2 7"/></svg>;
}

export function VoicemailIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><circle cx="6" cy="12" r="4"/><circle cx="18" cy="12" r="4"/><line x1="6" x2="18" y1="16" y2="16"/></svg>;
}

export function HistoryIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>;
}

export function CogIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>;
}

export function CreditCardIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>;
}

export function PlusIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><line x1="12" x2="12" y1="5" y2="19"/><line x1="5" x2="19" y1="12" y2="12"/></svg>;
}

export function RefreshIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>;
}

export function CheckCircleIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>;
}

export function AlertCircleIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>;
}

export function SendIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><line x1="22" x2="11" y1="2" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>;
}

export function PaperclipIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>;
}

export function DownloadIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>;
}

export function PlayIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><polygon points="5 3 19 12 5 21 5 3"/></svg>;
}

export function PauseIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>;
}

export function TrashIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>;
}

export function SearchIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/></svg>;
}

export function UserIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>;
}

export function LogoutIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>;
}

export function ArrowRightIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><line x1="5" x2="19" y1="12" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>;
}

export function ChevronDownIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><polyline points="6 9 12 15 18 9"/></svg>;
}

export function UploadIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>;
}

export function FileTextIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/><line x1="10" x2="8" y1="9" y2="9"/></svg>;
}

export function XIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg>;
}

export function EyeIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>;
}

export function PrinterIcon({ size = 24, ...p }: IconProps) {
  return <svg {...mks(size)} {...p}><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 12H4a2 2 0 0 0-2 2v5h4v-7h12v7h4v-5a2 2 0 0 0-2-2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>;
}
