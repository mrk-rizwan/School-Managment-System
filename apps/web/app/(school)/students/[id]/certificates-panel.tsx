'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { QueryStates } from '@/components/page-states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import { certificatesApi } from '@/lib/api/school-certificates-contract';
import { formatDay } from '@/lib/format';
import {
  CertificateBadges,
  certificatesKeys,
  IssueCertificateForm,
  printCertificate,
} from '../../certificates/_lib/certificates-ui';

/**
 * The student's certificates (phase-4-academic.md slice 34), on the student page's Certificates
 * tab: what has been issued, newest first, with print and a quick issue. The register
 * (/certificates) reissues and voids. Shown to certificate.issue holders, with or without
 * fee.statement.view (wave N review).
 */
export function CertificatesPanel({ student }: { student: { id: string; fullName: string } }) {
  const [issuing, setIssuing] = useState(false);
  const certificates = useQuery({
    queryKey: certificatesKeys.forStudent(student.id),
    queryFn: () =>
      unwrap(
        certificatesApi.GET('/api/v1/students/{id}/certificates', {
          params: { path: { id: student.id }, query: { limit: 50 } },
        }),
      ),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1.5">
          <CardTitle>Certificates</CardTitle>
          <CardDescription>A leaving certificate needs the student’s dues cleared, or overridden by a principal.</CardDescription>
        </div>
        <Button variant="outline" onClick={() => setIssuing(true)}>
          Issue certificate
        </Button>
      </CardHeader>
      <CardContent>
        <QueryStates query={certificates} loadingRows={2}>
          {(page) =>
            page.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">No certificate has been issued to this student.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="px-3 text-muted-foreground">No.</TableHead>
                      <TableHead className="px-3 text-muted-foreground">Certificate</TableHead>
                      <TableHead className="px-3 text-muted-foreground">Issued</TableHead>
                      <TableHead className="px-3 text-right text-muted-foreground">
                        <span className="sr-only">Print</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {page.data.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="px-3">
                          <CertificateBadges certificate={c} />
                        </TableCell>
                        <TableCell className="px-3">{c.title}</TableCell>
                        <TableCell className="px-3">{formatDay(c.issuedOn)}</TableCell>
                        <TableCell className="px-3 text-right">
                          <Button variant="ghost" size="sm" onClick={() => printCertificate(c.id)} aria-label={`Print ${c.label}`}>
                            Print
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )
          }
        </QueryStates>
      </CardContent>
      <Dialog open={issuing} onOpenChange={setIssuing}>
        <DialogContent>
          {issuing && <IssueCertificateForm student={student} onDone={() => setIssuing(false)} onCancel={() => setIssuing(false)} />}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
