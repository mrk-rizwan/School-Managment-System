import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** A card with a title, a sentence and one link onward: the end states of the emailed links. */
export function LinkOutcome({
  title,
  description,
  href,
  linkLabel,
}: {
  title: string;
  description: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Link href={href} className={buttonVariants({ variant: 'outline', className: 'w-full' })}>
          {linkLabel}
        </Link>
      </CardContent>
    </Card>
  );
}
