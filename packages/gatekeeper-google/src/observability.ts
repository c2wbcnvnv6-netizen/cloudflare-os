import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the Google gatekeeper. */
export type GoogleObservabilityFields = {
  actionId: number | string;
  /** Which kind of queued action a log is about. */
  actionKind: string;
  /** A Drive comment or reply ID. */
  commentId: string;
  conversionKind: string;
  copyFileId: string;
  fileId: string;
  folderId: string;
  /** Whether a converted PDF had a text layer. */
  hasText: boolean;
  httpStatus: number;
  messageId: string;
  method: string;
  /** Whether a shape the model of Google Docs has no answer for is one nothing the gatekeeper sends should reach. */
  modelInvariant: boolean;
  /** The shape the model of Google Docs has no answer for, as the model names it; never document text. */
  modelShape: string;
  /** Where the model of Google Docs threw: the frames of the error's stack, without its message. */
  modelStack: string;
  operation: string;
  /** How an operation ended, as a class rather than a message. */
  outcome: string;
  /** Size of a PDF sent for conversion, in bytes. */
  pdfBytes: number;
  provider: string;
  providerCode: number;
  providerReasons: string[];
  providerStatus: string;
  userObjectId: string;
  vendorId: string;
};

/** Ambient observability fields for one Google gatekeeper operation. */
export const obsContext = createObservabilityContext<GoogleObservabilityFields>();
