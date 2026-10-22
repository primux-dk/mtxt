'use client';

import { Mic, Plus, Upload } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { UploadDialog } from './upload-dialog';

/**
 * "New meeting", the library's one primary action: the choice between
 * recording in the browser and uploading a file (docs/design/README.md).
 */
export function NewMeetingMenu({
  label,
  recordLabel,
  uploadLabel,
  canRecord,
  canUpload,
}: {
  label: string;
  recordLabel: string;
  uploadLabel: string;
  canRecord: boolean;
  canUpload: boolean;
}) {
  const [uploading, setUploading] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="primary" className="max-shell:px-3 max-shell:text-xs">
            <Plus aria-hidden="true" />
            {label}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild disabled={!canRecord}>
            <Link href="/meetings/new">
              <Mic aria-hidden="true" />
              {recordLabel}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canUpload} onSelect={() => setUploading(true)}>
            <Upload aria-hidden="true" />
            {uploadLabel}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <UploadDialog open={uploading} onOpenChange={setUploading} />
    </>
  );
}

/** A secondary button that opens the upload dialog: "Upload audio", "Upload a file". */
export function UploadButton({
  label,
  className,
  meetingId,
  disabled,
}: {
  label: string;
  className?: string;
  meetingId?: string;
  disabled?: boolean;
}) {
  return (
    <UploadDialog
      meetingId={meetingId}
      trigger={
        <Button className={className} disabled={disabled}>
          <Upload aria-hidden="true" />
          {label}
        </Button>
      }
    />
  );
}
