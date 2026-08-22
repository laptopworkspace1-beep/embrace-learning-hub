import { memo } from "react";
import { Textarea } from "@/components/ui/textarea";

type Props = {
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
  placeholder?: string;
};

/**
 * The code / stdin editors live inside a screen that re-renders every couple of
 * seconds (server clock sync, live round state, presence). Memoising them keeps
 * the largest DOM subtree on the page out of those render passes: it only
 * re-renders when the text or its enabled state actually changes.
 */
export const CodeEditor = memo(function CodeEditor({
  value,
  onValueChange,
  disabled,
  className,
  id,
  placeholder,
}: Props) {
  return (
    <Textarea
      {...(id ? { id } : {})}
      {...(placeholder ? { placeholder } : {})}
      className={className}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      disabled={disabled}
      spellCheck={false}
    />
  );
});
