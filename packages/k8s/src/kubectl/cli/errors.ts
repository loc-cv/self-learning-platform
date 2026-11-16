// Errors as kubectl prints them. Go commands return error values and kubectl's main hands them to
// cmdutil.CheckErr, which picks the message by the error's type; here errors are tagged data and
// `errorMessage` is that switch.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/util/helpers.go checkErr, StandardErrorMessage,
//             MultilineError, MultipleErrors, statusCausesToAggrError, fatal
//   upstream: staging/src/k8s.io/apimachinery/pkg/api/errors/errors.go StatusError.Error (the message)

import type { Status } from '../../apimachinery/errors.ts';

export type KubectlError =
  /** A Status from the API server (apierrors.APIStatus). */
  | { type: 'status'; status: Status }
  /** A *url.Error: the request did not reach a server. */
  | { type: 'url'; op: string; url: string; err: string }
  /** An aggregate of errors (utilerrors.Aggregate). */
  | { type: 'aggregate'; errors: KubectlError[] }
  /** clientcmd's invalid configuration (IsConfigurationInvalid). */
  | { type: 'config'; errors: string[] }
  /** Any other error: printed as `error: <message>` unless it already starts so. */
  | { type: 'message'; message: string }
  /** cmdutil.ErrExit: exit 1 with nothing printed. */
  | { type: 'exit' }
  /** Something the simulator does not model: the caller prints a `[sim]` notice instead. */
  | { type: 'notSimulated'; what: string };

export const DEFAULT_ERROR_EXIT_CODE = 1;

export function messageError(message: string): KubectlError {
  return { type: 'message', message };
}

/** The text of a Status error: its message (StatusError.Error). */
function statusText(s: Status): string {
  return s.message ?? '';
}

/** StandardErrorMessage: undefined when the error is not one it recognizes. */
function standardErrorMessage(err: KubectlError): string | undefined {
  if (err.type === 'status') {
    const s = err.status;
    if (s.reason === 'Unauthorized') return `error: You must be logged in to the server (${s.message ?? ''})`;
    if (s.reason) return `Error from server (${s.reason}): ${statusText(s)}`;
    return `Error from server: ${statusText(s)}`;
  }
  if (err.type === 'url') {
    if (err.err.includes('connection refused')) {
      return `The connection to the server ${hostOf(err.url)} was refused - did you specify the right host or port?`;
    }
    return `Unable to connect to the server: ${err.err}`;
  }
  return undefined;
}

/** url.Parse(u).Host */
function hostOf(u: string): string {
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/.exec(u);
  if (!m) return u;
  const auth = m[1] as string;
  const at = auth.lastIndexOf('@');
  return at >= 0 ? auth.slice(at + 1) : auth;
}

function plainText(err: KubectlError): string {
  switch (err.type) {
    case 'status':
      return statusText(err.status);
    case 'url':
      return `${err.op} "${err.url}": ${err.err}`;
    case 'aggregate':
      return err.errors.length === 1 ? plainText(err.errors[0] as KubectlError) : `[${err.errors.map(plainText).join(', ')}]`;
    case 'config':
      return err.errors.join(', ');
    case 'message':
      return err.message;
    case 'exit':
      return 'exit';
    case 'notSimulated':
      return err.what;
  }
}

/** messageForError */
function messageFor(err: KubectlError): string {
  return standardErrorMessage(err) ?? plainText(err);
}

/**
 * What CheckErr writes to standard error for `err` (ending in a newline, or empty), and the exit
 * code. `fatal` adds the newline when the message lacks one.
 */
export function errorMessage(err: KubectlError): { text: string; code: number } {
  // Unwrap aggregates of one.
  if (err.type === 'aggregate' && err.errors.length === 1) err = err.errors[0] as KubectlError;
  const done = (msg: string) => ({ text: msg === '' ? '' : msg.endsWith('\n') ? msg : msg + '\n', code: DEFAULT_ERROR_EXIT_CODE });
  switch (err.type) {
    case 'exit':
      return done('');
    case 'status': {
      const s = err.status;
      if (s.reason === 'Invalid' && s.code === 422) {
        const details = s.details;
        let t = 'The request is invalid';
        if (!details) return done(s.message ? `${t}: ${s.message}` : t);
        if (details.kind || details.name) t = `The ${details.kind ?? ''} "${details.name ?? ''}" is invalid`;
        else if (s.message && !(details.causes && details.causes.length > 0)) t += ': ' + s.message;
        const causes = details.causes ?? [];
        if (causes.length === 0) return done(t);
        // statusCausesToAggrError drops duplicate messages; MultilineError lists them.
        const msgs: string[] = [];
        for (const c of causes) {
          const m = `${c.field ?? ''}: ${c.message ?? ''}`;
          if (!msgs.includes(m)) msgs.push(m);
        }
        if (msgs.length === 1) return done(`${t}: ${msgs[0]}\n`);
        return done(`${t}: \n${msgs.map((m) => `* ${m}\n`).join('')}`);
      }
      return done(messageFor(err));
    }
    case 'config':
      if (err.errors.length === 1) return done(`Error in configuration: ${err.errors[0]}\n`);
      return done(`Error in configuration: \n${err.errors.map((m) => `* ${m}\n`).join('')}`);
    case 'aggregate':
      return done(err.errors.map((e) => `${messageFor(e)}\n`).join(''));
    default: {
      const std = standardErrorMessage(err);
      if (std !== undefined) return done(std);
      const msg = plainText(err);
      return done(msg.startsWith('error: ') ? msg : `error: ${msg}`);
    }
  }
}
