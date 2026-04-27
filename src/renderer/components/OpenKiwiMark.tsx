/** Product name: “Open” + green “Kiwi” in Monomaniac One. */
export function OpenKiwiMark({ className }: { className?: string }) {
  return (
    <span className={`openkiwi-mark${className ? ` ${className}` : ''}`}>
      <span className="openkiwi-mark__open">Open</span>
      <span className="openkiwi-mark__kiwi">Kiwi</span>
    </span>
  );
}
