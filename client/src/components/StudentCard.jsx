import { useState } from 'react';
import { fmtDate, fmtTimeSec, directionLabel } from '../lib/format.js';

/*
 * The verified-student card, same layout as the Apps Script page: red "BUS NO." header, photo,
 * name, course, route (pickup point), enrollment number and a green VERIFIED badge with the time.
 */
const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 125 145"><rect width="125" height="145" fill="#eaf2fc"/><circle cx="62.5" cy="55" r="24" fill="#b9cde6"/><path d="M20 135c4-28 22-42 42.5-42S101 107 105 135z" fill="#b9cde6"/></svg>',
);

export function StudentCard({ student, busNumber, verifiedAt, already = false, direction, photoSrc = null }) {
  const [photoOk, setPhotoOk] = useState(true);
  // the selfie just taken on this phone (if any), else the photo on record, else a placeholder
  const photo = photoSrc || (student.photo_url && photoOk ? student.photo_url : PLACEHOLDER);
  const hasPhoto = !!photoSrc || (!!student.photo_url && photoOk);
  return (
    <div className="mx-auto w-full max-w-[460px] overflow-hidden rounded-[18px] border border-line bg-white text-center shadow-[0_8px_28px_#102b4a12] animate-pop">
      <div className="bg-uured px-4 py-4 text-[23px] font-bold tracking-wide text-white">
        BUS NO. {busNumber || student.bus?.number || '—'}
      </div>
      <div className="p-[22px]">
        <img src={photo} alt={hasPhoto ? student.name : ""} referrerPolicy="no-referrer"
          onError={() => setPhotoOk(false)}
          className="mx-auto mb-4 block h-[133px] w-[110px] rounded-xl border-[3px] border-line bg-brand-soft object-cover shadow-[0_6px_16px_-8px_rgb(16_43_74/0.35)]" />
        <h2 className="my-2 text-2xl font-bold text-navy">{student.name}</h2>
        <p className="my-2 break-words"><strong>Course:</strong> {student.course || '—'}</p>
        <p className="my-2 break-words"><strong>Route:</strong> {student.stop || '—'}</p>
        <p className="my-2 break-words"><strong>Enrollment No.:</strong> {student.enrollment_no || student.uuid || '—'}</p>
        {already
          ? <div className="check-pop mt-4 inline-block rounded-full bg-warn-soft px-4 py-2 font-bold text-warn [animation-delay:200ms]">✓ ALREADY VERIFIED</div>
          : <div className="check-pop mt-4 inline-block rounded-full bg-ok-soft px-4 py-2 font-bold text-ok [animation-delay:200ms]">✓ VERIFIED</div>}
        {verifiedAt && (
          <p className="mt-2 text-sm text-muted">
            {fmtDate(verifiedAt)}, {fmtTimeSec(verifiedAt)}{direction ? ` · ${directionLabel(direction)}` : ''}
          </p>
        )}
      </div>
    </div>
  );
}
