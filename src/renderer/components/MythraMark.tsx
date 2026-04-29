export function MythraMark({ className }: { className?: string }) {
  return (
    <span className={`mythra-mark${className ? ` ${className}` : ''}`}>Mythra</span>
  );
}
