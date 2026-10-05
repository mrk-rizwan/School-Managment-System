import {
  ApiError,
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_CATEGORIES,
  ANNOUNCEMENT_CATEGORY_LABELS,
  ANNOUNCEMENT_TITLE_MAX,
  newIdempotencyKey,
  type AnnouncementCategory,
  type AnnouncementPriority,
} from '@asms/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api, unwrap, unwrapWithDate } from '../api/client';
import type { AnnouncementDto, ClassDto, SectionDto } from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import { useCachedQuery } from '../db/use-cached-query';
import { useOnlineOnly } from '../net/connectivity';
import { sensitiveTextError } from '../outbox/bodies';
import { log } from '../platform/log';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { ModalSheet } from '../ui/ModalSheet';
import { Screen } from '../ui/Screen';
import { SegmentedPicker } from '../ui/SegmentedPicker';
import { colors, fontSize, space } from '../ui/theme';
import {
  audiencesFor,
  CHOICE_LABELS,
  previewFailure,
  previewLine,
  reusedKeyId,
  sendFailure,
  SMS_SEGMENT_HINT,
  warningLines,
  type AudienceChoice,
  type ChoiceKind,
  type PreviewState,
} from './announce-model';

// New announcement — /announce/new (slice-16 §7.2, slice-14 §12): a short notice, online only.
// The Idempotency-Key is generated when the form opens and lives in this component's state only
// — never in the outbox, never on disk (decision 9, slice-14 decision 13). A changed body (send
// without SMS) is a new key. Create then send: a failure between them leaves a draft the list
// can send. No names on this screen: not secure.

const PREVIEW_DEBOUNCE_MS = 600;

type Page<T> = { data: T[]; page: number; limit: number; total: number };

/**
 * POST /announcements/preview-audience, one request at a time: a change made while one is in
 * flight is sent when it returns, and only the latest request's answer is shown. After a 429 no
 * request goes out until the wait the server named has passed (review L3).
 */
export function createPreviewer(show: (state: PreviewState) => void, now: () => number = Date.now) {
  const previewer = {
    latest: null as string | null,
    inFlight: false,
    /** Epoch ms before which counting stays paused (0: not paused). */
    pausedUntil: 0,
    /** The request the form holds now (null: nothing to count); older answers are dropped. */
    want(json: string | null): void {
      previewer.latest = json;
    },
    async run(json: string): Promise<void> {
      if (previewer.inFlight || now() < previewer.pausedUntil) return;
      previewer.inFlight = true;
      try {
        const result = await unwrap(
          api.POST('/api/v1/announcements/preview-audience', {
            body: JSON.parse(json) as never,
          }),
        );
        if (previewer.latest === json) show({ kind: 'ready', preview: result });
      } catch (error) {
        if (error instanceof ApiError && error.status === 429) {
          previewer.pausedUntil = now() + (error.retryAfterSeconds ?? 60) * 1000;
        }
        if (previewer.latest === json) show(previewFailure(error));
      } finally {
        previewer.inFlight = false;
        const next = previewer.latest;
        if (next !== null && next !== json) void previewer.run(next);
      }
    },
  };
  return previewer;
}

export function ComposeScreen() {
  const router = useRouter();
  const client = useQueryClient();
  const createGate = useOnlineOnly('create_announcement');
  const previewGate = useOnlineOnly('preview_audience');
  const sendGate = useOnlineOnly('send_announcement');
  const online = createGate.enabled && previewGate.enabled && sendGate.enabled;

  // Made once per open of the form; never stored (decision 9).
  const [key] = useState(newIdempotencyKey);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<AnnouncementPriority>('normal');
  const [category, setCategory] = useState<AnnouncementCategory>('general');
  const [choice, setChoice] = useState<AudienceChoice>({ kind: 'everyone' });
  const [classId, setClassId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ kind: 'idle' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [capExceeded, setCapExceeded] = useState(false);
  const [busy, setBusy] = useState(false);

  const classes = useCachedQuery<Page<ClassDto>>(
    queryKeys.classes(1),
    '/api/v1/classes',
    { status: 'active', limit: 50, page: 1 },
    () =>
      unwrapWithDate(
        api.GET('/api/v1/classes', { params: { query: { status: 'active', limit: 50, page: 1 } } }),
      ),
    { enabled: choice.kind === 'class' || choice.kind === 'section' },
  );
  const sections = useCachedQuery<Page<SectionDto>>(
    queryKeys.classSections(classId ?? 'none'),
    `/api/v1/classes/${classId ?? 'none'}/sections`,
    { limit: 50 },
    () =>
      unwrapWithDate(
        api.GET('/api/v1/classes/{id}/sections', {
          params: { path: { id: classId! }, query: { limit: 50 } },
        }),
      ),
    { enabled: choice.kind === 'section' && classId !== null },
  );

  const audiences = audiencesFor(choice);
  const request =
    audiences === null
      ? null
      : {
          audiences,
          priority,
          ...(title.trim() === '' ? {} : { title: title.trim() }),
          ...(body.trim() === '' ? {} : { body: body.trim() }),
        };
  const requestJson = request === null ? null : JSON.stringify(request);

  // Preview on every change, debounced, at most one in flight; the latest request wins.
  const [previewer] = useState(() => createPreviewer(setPreview));
  useEffect(() => {
    previewer.want(requestJson);
    if (requestJson === null || !online) return undefined;
    const timer = setTimeout(() => void previewer.run(requestJson), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [requestJson, online, previewer]);

  function validate(): boolean {
    const problems: Record<string, string> = {};
    const t = title.trim();
    const b = body.trim();
    // Mirrors the server: notice text refuses identity and phone numbers (slice-14 §1.5).
    if (t === '') problems.title = 'Enter a title.';
    else if (sensitiveTextError(t)) problems.title = sensitiveTextError(t)!;
    if (b === '') problems.body = 'Enter the message.';
    else if (sensitiveTextError(b)) problems.body = sensitiveTextError(b)!;
    if (audiences === null) problems.audience = 'Choose who receives it.';
    setErrors(problems);
    return Object.keys(problems).length === 0;
  }

  async function send(withoutSms = false) {
    if (audiences === null) return;
    // Once a draft exists its content is fixed here: Send sends that draft and nothing else.
    let id = createdId;
    setBusy(true);
    setMessage(null);
    setCapExceeded(false);
    try {
      if (id === null) {
        const created: AnnouncementDto = await unwrap(
          api.POST('/api/v1/announcements', {
            params: { header: { 'Idempotency-Key': key } },
            body: {
              title: title.trim(),
              body: body.trim(),
              category,
              priority,
              audiences,
            },
          }),
        );
        id = created.id;
        setCreatedId(id);
      }
      if (withoutSms) {
        // The same draft, made normal: never a second announcement (review L2).
        await unwrap(
          api.PATCH('/api/v1/announcements/{id}', {
            params: { path: { id } },
            body: { priority: 'normal' },
          }),
        );
        setPriority('normal');
      }
      // `sending` (send-now hands delivery to a job) and `sent` are both success; so is
      // `scheduled`. Nothing here waits for `sent`.
      const result = await unwrap(
        api.POST('/api/v1/announcements/{id}/send', { params: { path: { id } } }),
      );
      log('info', 'announcement.sent', { announcementId: id, status: result.status });
      setConfirmOpen(false);
      void client.invalidateQueries({ queryKey: ['announcements'] });
      router.back();
    } catch (error) {
      const failure = sendFailure(error, id !== null);
      setMessage(failure.message);
      setCapExceeded(failure.kind === 'cap');
      if (failure.kind === 'key_reused') await openExistingDraft(error);
    } finally {
      setBusy(false);
    }
  }

  /**
   * IDEMPOTENCY_KEY_REUSED (the first create reached the server, then the form changed): open the
   * draft already saved — by the id the answer names when it names one, else the one draft with
   * this exact title; never a guess. Otherwise the list, which shows it.
   */
  async function openExistingDraft(error: unknown) {
    await client.invalidateQueries({ queryKey: ['announcements'] });
    setConfirmOpen(false);
    const named = reusedKeyId(error);
    if (named !== null) {
      router.replace({ pathname: '/announce/[id]', params: { id: named } });
      return;
    }
    try {
      const page = await unwrap(
        api.GET('/api/v1/announcements', {
          params: { query: { status: 'draft', sort: '-createdAt', limit: 25 } },
        }),
      );
      const matches = page.data.filter((d) => d.title === title.trim());
      if (matches.length === 1) {
        router.replace({ pathname: '/announce/[id]', params: { id: matches[0]!.id } });
      } else {
        router.replace('/announce');
      }
    } catch {
      // The message already says what happened; the list shows the draft.
    }
  }

  // The tab needs announcement.send.school, which reaches the whole school (slice-14 §1.2).
  const kinds: ChoiceKind[] = ['everyone', 'parents', 'students', 'staff', 'class', 'section'];
  const locked = createdId !== null;
  const editable = online && !locked;
  const parentsOnly =
    choice.kind === 'class' || choice.kind === 'section' ? choice.parentsOnly : false;
  const pickTarget = (kind: 'class' | 'section', targetId: string | null) =>
    setChoice({ kind, targetId, parentsOnly });

  const sectionOptions = (sections.data?.body.data ?? [])
    .filter((s) => s.archivedAt === null)
    .map((s) => ({ value: s.id, label: s.name }));

  const previewText =
    preview.kind === 'ready'
      ? previewLine(preview.preview)
      : preview.kind === 'idle'
        ? audiences === null
          ? 'Choose who receives it.'
          : 'Counting…'
        : preview.message;

  return (
    <Screen
      title="New announcement"
      testID="announce.compose"
      banner={
        online ? null : (
          <Banner tone="warning" text="Needs a connection" testID="announce.offline" />
        )
      }
      footer={
        <>
          <Text style={styles.preview} testID="announce.preview">
            {previewText}
          </Text>
          {preview.kind === 'ready'
            ? warningLines(preview.preview).map((line) => (
                <Text key={line} style={styles.warning}>
                  {line}
                </Text>
              ))
            : null}
          {message && !confirmOpen ? (
            <Text style={styles.error} testID="announce.message">
              {message}
            </Text>
          ) : null}
          <Button
            label={createdId === null ? 'Send' : 'Send draft'}
            disabled={!online}
            onPress={() => {
              if (validate()) setConfirmOpen(true);
            }}
            testID="announce.send"
          />
        </>
      }
    >
      {locked ? (
        <Text style={styles.note} testID="announce.locked">
          Saved as a draft. Send it, or edit it from the list.
        </Text>
      ) : null}
      <Field
        label="Title"
        value={title}
        maxLength={ANNOUNCEMENT_TITLE_MAX}
        editable={editable}
        error={errors.title}
        onChangeText={setTitle}
        testID="announce.title"
      />
      <Field
        label="Message"
        value={body}
        multiline
        maxLength={ANNOUNCEMENT_BODY_MAX}
        editable={editable}
        error={errors.body}
        hint={`${body.length} / ${ANNOUNCEMENT_BODY_MAX}${
          priority === 'urgent' && body.length > SMS_SEGMENT_HINT ? ' · Longer than one SMS' : ''
        }`}
        onChangeText={setBody}
        testID="announce.body"
      />
      <SegmentedPicker
        label="Priority"
        options={[
          { value: 'normal', label: 'Normal' },
          { value: 'urgent', label: 'Urgent (WhatsApp and SMS)' },
        ]}
        value={priority}
        onChange={(value) => setPriority(value)}
        disabled={!editable}
        testID="announce.priority"
      />
      <SegmentedPicker
        label="Category"
        options={ANNOUNCEMENT_CATEGORIES.map((c) => ({
          value: c,
          label: ANNOUNCEMENT_CATEGORY_LABELS[c],
        }))}
        value={category}
        onChange={setCategory}
        disabled={!editable}
        testID="announce.category"
      />
      <SegmentedPicker
        label="Who receives it"
        options={kinds.map((k) => ({ value: k, label: CHOICE_LABELS[k] }))}
        value={choice.kind}
        onChange={(kind) => {
          setClassId(null);
          setChoice(
            kind === 'class' || kind === 'section'
              ? { kind, targetId: null, parentsOnly }
              : { kind },
          );
        }}
        disabled={!editable}
        testID="announce.audience"
      />
      {errors.audience ? <Text style={styles.error}>{errors.audience}</Text> : null}
      {choice.kind === 'class' || choice.kind === 'section' ? (
        classes.data === undefined ? (
          <Text style={styles.note}>
            {classes.isError ? 'Cannot load classes.' : 'Loading classes…'}
          </Text>
        ) : (
          <SegmentedPicker
            label="Class"
            options={classes.data.body.data.map((c) => ({ value: c.id, label: c.name }))}
            value={choice.kind === 'class' ? choice.targetId : classId}
            onChange={(id) => {
              setClassId(id);
              pickTarget(choice.kind, choice.kind === 'class' ? id : null);
            }}
            disabled={!editable}
            testID="announce.class"
          />
        )
      ) : null}
      {choice.kind === 'section' && classId !== null ? (
        <SegmentedPicker
          label="Section"
          options={sectionOptions}
          value={choice.targetId}
          onChange={(id) => pickTarget('section', id)}
          disabled={!editable}
          testID="announce.section"
        />
      ) : null}
      {choice.kind === 'class' || choice.kind === 'section' ? (
        <SegmentedPicker
          label="Send to"
          options={[
            { value: 'both', label: 'Parents and students' },
            { value: 'parents', label: 'Parents only' },
          ]}
          value={parentsOnly ? 'parents' : 'both'}
          onChange={(value) => setChoice({ ...choice, parentsOnly: value === 'parents' })}
          disabled={!editable}
          testID="announce.roles"
        />
      ) : null}
      <View style={styles.spacer} />

      <ModalSheet
        visible={confirmOpen}
        title="Send this announcement?"
        onClose={() => setConfirmOpen(false)}
        testID="announce.confirm"
        footer={
          <>
            {message ? (
              <Text style={styles.error} testID="announce.confirm.message">
                {message}
              </Text>
            ) : null}
            {capExceeded ? (
              <Button
                label="Send without SMS"
                variant="secondary"
                disabled={!online}
                busy={busy}
                onPress={() => void send(true)}
                testID="announce.confirm.withoutSms"
              />
            ) : null}
            <Button
              label="Send now"
              disabled={!online}
              busy={busy}
              onPress={() => void send()}
              testID="announce.confirm.send"
            />
          </>
        }
      >
        <Text style={styles.body}>{title.trim()}</Text>
        <Text style={styles.preview}>{previewText}</Text>
        {priority === 'urgent' ? (
          <Text style={styles.note}>Urgent: WhatsApp and SMS together.</Text>
        ) : null}
      </ModalSheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  preview: { fontSize: fontSize.small, color: colors.foreground, fontWeight: '600' },
  warning: { fontSize: fontSize.small, color: colors.destructive },
  error: { fontSize: fontSize.small, color: colors.destructive },
  note: { fontSize: fontSize.small, color: colors.mutedForeground },
  body: { fontSize: fontSize.body, color: colors.foreground },
  spacer: { height: space.lg },
});
