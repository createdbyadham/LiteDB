import { Check, CircleAlert } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"

export function Toaster() {
  const { toasts } = useToast()

  return (
    <ToastProvider duration={4000} swipeDirection="down">
      {toasts.map(function ({ id, title, description, action, variant, ...props }) {
        const destructive = variant === "destructive"
        return (
          <Toast key={id} variant={variant} {...props}>
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                className={
                  destructive
                    ? "flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-500/15 text-red-400"
                    : "flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400"
                }
              >
                {destructive ? (
                  <CircleAlert className="h-3 w-3" />
                ) : (
                  <Check className="h-3 w-3" strokeWidth={3} />
                )}
              </span>
              <div className="flex min-w-0 items-baseline gap-2">
                {title && <ToastTitle className="shrink-0">{title}</ToastTitle>}
                {description && (
                  <ToastDescription className="truncate">{description}</ToastDescription>
                )}
              </div>
            </div>
            {action}
            <ToastClose />
          </Toast>
        )
      })}
      <ToastViewport />
    </ToastProvider>
  )
}
