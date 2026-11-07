import { cleanup, openUrl, Scroll, signal, Text, View } from "nsh";
import { Button, Input } from "nsh/base";
import { t } from "./i18n";
import { list, record, text, type FormAnswer, type Row } from "./model";
import { epoch, type createChat } from "./state";

type Chat = ReturnType<typeof createChat>;
type Value = FormAnswer[string];
type Draft = Record<string, Value>;
type RequestRow = () => Row;
type Scope = {
  chat: Chat;
  disabled: () => boolean;
  perform: (
    work: () => Promise<void>,
    failure: (message: string) => void,
  ) => Promise<void>;
};
const action =
  "min-h-11 px-4 py-3 rounded-xl bg-secondary active:bg-accent disabled:opacity-40 items-center justify-center";
const selectedAction =
  "min-h-11 px-4 py-3 rounded-xl bg-accent active:bg-accent disabled:opacity-40 items-center justify-center";
const input =
  "min-h-12 px-3 py-3 rounded-xl bg-secondary text-foreground disabled:opacity-40";
const types = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "multiselect",
  "external",
]);
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
const scalar = (value: unknown): value is string | number | boolean =>
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

function options(field: Row) {
  return list(field.options).filter(
    (option) =>
      typeof option.value === "string" && typeof option.label === "string",
  );
}
function initialValue(field: Row): Value | undefined {
  if (field.type === "external") return undefined;
  if (field.type === "boolean")
    return typeof field.default === "boolean" ? field.default : false;
  if (field.type === "multiselect")
    return strings(field.default).filter((value) =>
      options(field).some((option) => option.value === value),
    );
  if (field.type === "number" || field.type === "integer")
    return typeof field.default === "number" && Number.isFinite(field.default)
      ? String(field.default)
      : "";
  return typeof field.default === "string"
    ? field.default
    : text(options(field)[0]?.value);
}

// Numeric text stays in the draft (including incomplete input); wire values are typed.
function wireValue(field: Row, draft: Draft): Value | undefined {
  const value = Object.hasOwn(draft, text(field.key))
    ? draft[text(field.key)]
    : initialValue(field);
  if (field.type !== "number" && field.type !== "integer") return value;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())
  )
    return undefined;
  const number = Number(value);
  return Number.isFinite(number) &&
    (field.type !== "integer" || Number.isInteger(number))
    ? number
    : undefined;
}

function visibleFields(fields: Row[], draft: Draft): Row[] {
  const byKey = new Map(fields.map((field) => [text(field.key), field]));
  const memo = new Map<string, boolean>();
  function visible(field: Row, visiting: Set<string>): boolean {
    const key = text(field.key);
    if (memo.has(key)) return memo.get(key) === true;
    if (visiting.has(key)) return false;
    const next = new Set(visiting);
    next.add(key);
    // A when array is a conjunction of exact, typed eq/neq comparisons.
    // Hidden dependencies cannot keep descendants visible using retained drafts.
    const result =
      field.when === undefined ||
      (Array.isArray(field.when) &&
        list(field.when).every((condition) => {
          const dependency = byKey.get(text(condition.key));
          if (
            !dependency ||
            !visible(dependency, next) ||
            !scalar(condition.value)
          )
            return false;
          const value = wireValue(dependency, draft);
          return condition.op === "eq"
            ? value === condition.value
            : condition.op === "neq" && value !== condition.value;
        }));
    memo.set(key, result);
    return result;
  }
  return fields.filter((field) => visible(field, new Set()));
}

function schemaValid(fields: Row[]) {
  if (
    !fields.length ||
    new Set(fields.map((field) => text(field.key))).size !== fields.length
  )
    return false;
  const valid = fields.every((field) => {
    if (!text(field.key) || !types.has(text(field.type))) return false;
    if (field.type === "external" && !text(field.url)) return false;
    if (field.type === "multiselect" && !options(field).length) return false;
    if (field.when === undefined) return true;
    return (
      Array.isArray(field.when) &&
      field.when.every((value) => {
        const rule = record(value);
        return (
          text(rule.key) &&
          fields.some(
            (other) => other.key === rule.key && other.type !== "external",
          ) &&
          (rule.op === "eq" || rule.op === "neq") &&
          scalar(rule.value)
        );
      })
    );
  });
  if (!valid) return false;
  const byKey = new Map(fields.map((field) => [text(field.key), field]));
  const checked = new Set<string>();
  function acyclic(key: string, visiting: Set<string>): boolean {
    if (checked.has(key)) return true;
    if (visiting.has(key)) return false;
    const next = new Set(visiting);
    next.add(key);
    if (
      !list(byKey.get(key)?.when).every((rule) => acyclic(text(rule.key), next))
    )
      return false;
    checked.add(key);
    return true;
  }
  return fields.every((field) => acyclic(text(field.key), new Set()));
}

function validate(field: Row, draft: Draft): string {
  if (field.type === "external") return "";
  const value = wireValue(field, draft);
  const required = field.required === true;
  const invalid = () => t("chat.questionCard.inputNeeded");
  if (field.type === "number" || field.type === "integer") {
    const raw = Object.hasOwn(draft, text(field.key))
      ? draft[text(field.key)]
      : initialValue(field);
    const empty = typeof raw === "string" && !raw.trim();
    return (empty && !required) || typeof value === "number" ? "" : invalid();
  }
  if (field.type === "boolean")
    return typeof value === "boolean" ? "" : invalid();
  if (field.type === "multiselect") {
    return Array.isArray(value) &&
      (!required || value.length > 0) &&
      value.every((item) =>
        options(field).some((option) => option.value === item),
      )
      ? ""
      : invalid();
  }
  if (typeof value !== "string" || (required && !value.trim()))
    return invalid();
  const choices = options(field);
  return value &&
    choices.length &&
    field.custom !== true &&
    !choices.some((option) => option.value === value)
    ? invalid()
    : "";
}

function Field(props: {
  field: RequestRow;
  draft: () => Draft;
  set: (key: string, value: Value) => void;
  disabled: () => boolean;
  error: () => string;
  open: (url: string) => void;
}) {
  const f = props.field;
  const key = () => text(f().key);
  const value = () =>
    Object.hasOwn(props.draft(), key())
      ? props.draft()[key()]
      : initialValue(f());
  const title = () => text(f().title) || key();
  const selected = (option: Row) =>
    Array.isArray(value())
      ? strings(value()).includes(text(option.value))
      : value() === option.value;
  function choose(option: Row) {
    const chosen = text(option.value);
    if (f().type === "multiselect") {
      const previous = strings(value());
      props.set(
        key(),
        previous.includes(chosen)
          ? previous.filter((item) => item !== chosen)
          : [...previous, chosen],
      );
    } else props.set(key(), chosen);
  }
  return (
    <View class="gap-2">
      <Text class="text-sm font-semibold text-foreground">
        {title()}
        {f().required === true ? " *" : ""}
      </Text>
      <If when={!!text(f().description)}>
        <Text class="text-xs text-muted-foreground">
          {text(f().description)}
        </Text>
      </If>
      <If when={f().type === "external"}>
        <Text class="text-xs text-muted-foreground">{text(f().url)}</Text>
        <Button
          class={action}
          disabled={props.disabled()}
          onPress={() => props.open(text(f().url))}
        >
          <Text class="text-foreground">
            {t("contextPanel.preview.actions.openExternal")}
          </Text>
        </Button>
      </If>
      <If when={f().type === "boolean"}>
        <View class="flex-row gap-2">
          <Button
            class={value() === true ? selectedAction : action}
            selected={value() === true}
            disabled={props.disabled()}
            onPress={() => props.set(key(), true)}
          >
            <Text class="text-foreground">{t("settings.switch.on")}</Text>
          </Button>
          <Button
            class={value() === false ? selectedAction : action}
            selected={value() === false}
            disabled={props.disabled()}
            onPress={() => props.set(key(), false)}
          >
            <Text class="text-foreground">{t("settings.switch.off")}</Text>
          </Button>
        </View>
      </If>
      <If
        when={
          f().type === "multiselect" ||
          (f().type === "string" && options(f()).length > 0)
        }
      >
        <If when={f().type === "multiselect"}>
          <Text class="text-xs text-muted-foreground">
            {t("chat.questionCard.selectMultiple")}
          </Text>
        </If>
        <View class="gap-2">
          <Each of={options(f())} key={(option) => text(option.value)}>
            {(option) => (
              <Button
                class={selected(option()) ? selectedAction : action}
                selected={selected(option())}
                disabled={props.disabled()}
                onPress={() => choose(option())}
              >
                <Text class="text-foreground">
                  {selected(option()) ? "✓ " : ""}
                  {text(option().label)}
                </Text>
                <If when={!!text(option().description)}>
                  <Text class="text-xs text-muted-foreground">
                    {text(option().description)}
                  </Text>
                </If>
              </Button>
            )}
          </Each>
        </View>
      </If>
      <If
        when={
          f().type === "string" &&
          (options(f()).length === 0 || f().custom === true)
        }
      >
        <Input
          class={input}
          value={text(value())}
          disabled={props.disabled()}
          onChange={(event) => props.set(key(), event.value)}
          accessibilityLabel={title()}
          placeholder={
            text(f().placeholder) || t("chat.questionCard.yourAnswer")
          }
        />
      </If>
      <If when={f().type === "number" || f().type === "integer"}>
        <Input
          class={input}
          value={text(value())}
          disabled={props.disabled()}
          onChange={(event) => props.set(key(), event.value)}
          accessibilityLabel={title()}
          placeholder={f().type === "integer" ? "1" : "0.5"}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </If>
      <If when={!!props.error()}>
        <Text class="text-xs text-destructive">{props.error()}</Text>
      </If>
    </View>
  );
}

function FormRequest(props: { item: RequestRow; scope: Scope }) {
  const draft = signal<Draft>({}),
    errors = signal<Record<string, string>>({}),
    failure = signal("");
  const fields = () => list(props.item().fields);
  const visible = () => visibleFields(fields(), draft());
  const valid = () => schemaValid(fields());
  function set(key: string, value: Value) {
    draft.set({ ...draft(), [key]: value });
    errors.set({ ...errors(), [key]: "" });
  }
  async function reply() {
    if (props.scope.disabled()) return;
    const form = props.item(),
      formID = text(form.id);
    if (!valid() || !formID) {
      failure.set(t("chat.questionCard.submitFailed"));
      return;
    }
    const shown = visible(),
      snapshot = draft();
    const issues = Object.fromEntries(
      shown.map((field) => [text(field.key), validate(field, snapshot)]),
    );
    errors.set(issues);
    if (Object.values(issues).some(Boolean)) return;
    // Defaults and only visible fields are materialized into this click's answer.
    const answer: FormAnswer = Object.fromEntries(
      shown.flatMap((field) => {
        if (field.type === "external") return [];
        const value = wireValue(field, snapshot);
        return value === undefined ? [] : [[text(field.key), value]];
      }),
    );
    failure.set("");
    await props.scope.perform(
      () => props.scope.chat.replyForm(formID, answer),
      (message) => failure.set(message),
    );
  }
  async function cancel() {
    const formID = text(props.item().id);
    failure.set("");
    await props.scope.perform(
      () => props.scope.chat.cancelForm(formID),
      (message) => failure.set(message),
    );
  }
  async function open(url: string) {
    failure.set("");
    await props.scope.perform(
      async () => {
        if (!/^https?:\/\//i.test(url))
          throw new Error(t("contextPanel.preview.invalidUrl"));
        const result = await openUrl(url);
        if (!result.opened) throw new Error(t("miniChat.actions.failed"));
      },
      (message) => failure.set(message),
    );
  }
  return (
    <View class="bg-card rounded-2xl p-4 gap-4">
      <Text class="text-base font-semibold text-foreground">
        {text(props.item().title) || t("chat.form.title")}
      </Text>
      <If when={!valid()}>
        <Text class="text-sm text-destructive">
          {t("chat.questionCard.submitFailed")}
        </Text>
      </If>
      <Each of={visible()} key={(field) => text(field.key)}>
        {(field) => (
          <Field
            field={field}
            draft={draft}
            set={set}
            disabled={props.scope.disabled}
            error={() => text(errors()[text(field().key)])}
            open={(url) => {
              void open(url);
            }}
          />
        )}
      </Each>
      <If when={!!failure()}>
        <Text class="text-sm text-destructive">{failure()}</Text>
      </If>
      <View class="flex-row flex-wrap gap-2">
        <Button
          class={action}
          disabled={props.scope.disabled() || !valid()}
          onPress={() => {
            void reply();
          }}
        >
          <Text class="text-foreground">{t("chat.form.reply")}</Text>
        </Button>
        <Button
          class={action}
          disabled={props.scope.disabled()}
          onPress={() => {
            void cancel();
          }}
        >
          <Text class="text-foreground">{t("chat.form.cancel")}</Text>
        </Button>
      </View>
    </View>
  );
}

// Show each metadata leaf by its path, rather than dumping a JSON envelope.
function details(value: unknown, path = ""): { key: string; value: string }[] {
  if (value === null || scalar(value))
    return [{ key: path, value: String(value) }];
  if (Array.isArray(value))
    return value.flatMap((item, index) => details(item, `${path}[${index}]`));
  return Object.entries(record(value)).flatMap(([key, item]) =>
    details(item, path ? `${path}.${key}` : key),
  );
}

function PermissionRequest(props: { item: RequestRow; scope: Scope }) {
  const message = signal(""),
    failure = signal("");
  const actionName = () =>
    text(props.item().action) || text(props.item().permission);
  const patterns = () =>
    strings(props.item().resources ?? props.item().patterns);
  const savedPatterns = () => strings(props.item().save ?? props.item().always);
  const metadata = () => details(props.item().metadata);
  const source = () => details(props.item().source ?? props.item().tool);
  async function reply(decision: "once" | "always" | "reject") {
    const requestID = text(props.item().id),
      note = message();
    failure.set("");
    await props.scope.perform(
      () =>
        props.scope.chat.replyPermission(
          requestID,
          decision,
          note || undefined,
        ),
      (value) => failure.set(value),
    );
  }
  return (
    <View class="bg-card rounded-2xl p-4 gap-3">
      <Text class="text-base font-semibold text-foreground">
        {t("chat.permissionRequest.required")}
      </Text>
      <Text class="text-sm text-foreground">
        {t("chat.permissionCard.action")}{" "}
        {actionName() || t("chat.permissionToast.permissionFallback")}
      </Text>
      <If when={patterns().length > 0}>
        <Text class="text-xs text-muted-foreground">
          {t("chat.permissionCard.patterns")}
        </Text>
        <Each of={patterns()}>
          {(pattern) => (
            <Text class="text-sm text-foreground">{pattern()}</Text>
          )}
        </Each>
      </If>
      <If when={savedPatterns().length > 0}>
        <Text class="text-xs text-muted-foreground">
          {t("chat.permissionCard.alwaysAgree")}
        </Text>
        <Each of={savedPatterns()}>
          {(pattern) => (
            <Text class="text-sm text-foreground">{pattern()}</Text>
          )}
        </Each>
      </If>
      <If when={metadata().length > 0}>
        <Text class="text-xs text-muted-foreground">
          {t("chat.permissionCard.details")}
        </Text>
        <Each of={metadata()} key={(item) => item.key}>
          {(item) => (
            <View class="gap-1">
              <Text class="text-xs text-muted-foreground">{item().key}</Text>
              <Text class="text-sm text-foreground">{item().value}</Text>
            </View>
          )}
        </Each>
      </If>
      <If when={source().length > 0}>
        <Text class="text-xs text-muted-foreground">
          {t("chat.permissionCard.request")}
        </Text>
        <Each of={source()} key={(item) => item.key}>
          {(item) => (
            <View class="gap-1">
              <Text class="text-xs text-muted-foreground">{item().key}</Text>
              <Text class="text-xs text-foreground">{item().value}</Text>
            </View>
          )}
        </Each>
      </If>
      <Input
        class={input}
        multiline
        value={message()}
        disabled={props.scope.disabled()}
        onChange={(event) => message.set(event.value)}
        placeholder={t("chat.questionCard.yourAnswer")}
        accessibilityLabel={t("chat.questionCard.yourAnswer")}
      />
      <If when={!!failure()}>
        <Text class="text-sm text-destructive">{failure()}</Text>
      </If>
      <View class="flex-row flex-wrap gap-2">
        <Button
          class={action}
          disabled={props.scope.disabled()}
          onPress={() => {
            void reply("once");
          }}
        >
          <Text class="text-foreground">
            {t("chat.permissionRequest.actions.once")}
          </Text>
        </Button>
        <Button
          class={action}
          disabled={props.scope.disabled()}
          onPress={() => {
            void reply("always");
          }}
        >
          <Text class="text-foreground">
            {t("chat.permissionRequest.actions.always")}
          </Text>
        </Button>
        <Button
          class={action}
          disabled={props.scope.disabled()}
          onPress={() => {
            void reply("reject");
          }}
        >
          <Text class="text-foreground">
            {t("chat.permissionRequest.actions.reject")}
          </Text>
        </Button>
      </View>
    </View>
  );
}

export function BlockingRequests(props: {
  chat: ReturnType<typeof createChat>;
}) {
  const chat = props.chat,
    captured = epoch(),
    pending = signal(false);
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const current = () => alive && epoch() === captured && props.chat === chat;
  // Agent busy is expected while waiting for approval. It must not lock approval.
  const disabled = () =>
    pending() || chat.sending() || !chat.active() || !current();
  async function perform(
    work: () => Promise<void>,
    failure: (message: string) => void,
  ) {
    if (disabled()) return;
    pending.set(true);
    try {
      await work();
    } catch (error) {
      if (current())
        failure(
          error instanceof Error
            ? error.message
            : t("chat.questionCard.submitFailed"),
        );
    } finally {
      if (current()) pending.set(false);
    }
  }
  const scope: Scope = { chat, disabled, perform };
  return (
    <If when={chat.permissions().length > 0 || chat.forms().length > 0}>
      <Scroll class="max-h-80 shrink px-3" contentClass="gap-3 py-3">
        <Each
          of={chat.permissions()}
          key={(item) => `${text(item.sessionID)}:${text(item.id)}`}
        >
          {(item) => <PermissionRequest item={item} scope={scope} />}
        </Each>
        <Each
          of={chat.forms()}
          key={(item) => `${text(item.sessionID)}:${text(item.id)}`}
        >
          {(item) => <FormRequest item={item} scope={scope} />}
        </Each>
      </Scroll>
    </If>
  );
}
