import { memo, useState } from "react";
import type { UserInput } from "../../../shared/protocol";
import { useT } from "../../i18n";
import { TESTID } from "../testids";
import a11y from "./a11y.module.css";
import css from "./UserBubble.module.css";

export interface UserImage {
  key: string;
  src: string;
}

export const NO_IMAGES: readonly UserImage[] = [];

function fileUrl(path: string): string {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** Joins the text inputs of a user message and collects its image inputs; skills and mentions are not shown. */
export function userMessageParts(content: readonly UserInput[]): { text: string; images: readonly UserImage[] } {
  const texts: string[] = [];
  const images: UserImage[] = [];
  content.forEach((input, index) => {
    if (input.type === "text") texts.push(input.text);
    else if (input.type === "image") images.push({ key: `image:${index}`, src: input.url });
    else if (input.type === "localImage") images.push({ key: `image:${index}`, src: fileUrl(input.path) });
  });
  return { text: texts.join("\n"), images: images.length === 0 ? NO_IMAGES : images };
}

function Thumbnail({ src }: { src: string }) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  if (failed) return <span className={css.thumbFailed}>{t("conversation.image.failed")}</span>;
  return (
    <img
      className={css.thumb}
      src={src}
      alt={t("conversation.user.image")}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

/** DSH user bubble: right-aligned text with image thumbnails above it; `sending` marks an optimistic echo. */
export const UserBubble = memo(function UserBubble({
  text,
  images,
  sending = false,
}: {
  text: string;
  images: readonly UserImage[];
  sending?: boolean;
}) {
  const t = useT();
  return (
    <div
      className={css.row}
      data-testid={TESTID.userMessage}
      data-sending={sending || undefined}
      aria-busy={sending || undefined}
      data-flow="user"
    >
      <div className={css.stack}>
        {images.length > 0 && (
          <div className={css.attachments}>
            {images.map((image) => (
              <Thumbnail key={image.key} src={image.src} />
            ))}
          </div>
        )}
        {text !== "" && <div className={css.bubble}>{text}</div>}
        {sending && <span className={a11y.visuallyHidden}>{t("conversation.user.sending")}</span>}
      </div>
    </div>
  );
});
