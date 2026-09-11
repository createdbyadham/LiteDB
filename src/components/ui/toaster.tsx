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
            <div className="flex min-w-0 items-start gap-2.5">
              <span
                className={
                  destructive
                    ? "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-500/15 text-red-400"
                    : "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400"
                }
              >
                {destructive ? (
                  <CircleAlert className="h-3 w-3" />
                ) : (
                  <Check className="h-3 w-3" strokeWidth={3} />
                )}
              </span>
              <div className="min-w-0 space-y-0.5">
                {title && <ToastTitle>{title}</ToastTitle>}
                {description && (
                  <ToastDescription className="whitespace-normal break-words">
                    {description}
                  </ToastDescription>
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
