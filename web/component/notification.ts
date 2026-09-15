import { mountNotifications, pushNotification } from "../ui/notifications"

type NotificationLevel = "error" | "warn" | "info"

const notificationListElement = document.getElementById("notification-list")
if (notificationListElement) {
    mountNotifications(notificationListElement)
}

let alertedNotificationListNotFound = false

export function showNotification(message: string, level: NotificationLevel = "error", errorObject?: any) {
    console.error(message, errorObject)

    if (!notificationListElement) {
        if (!alertedNotificationListNotFound) {
            alert("couldn't find the notification element")
            alertedNotificationListNotFound = true
        }
        alert(message)
        return;
    }

    // Upstream wrote `else if (level = "info")` here — an assignment, always
    // truthy — so an unrecognised level silently rendered as info and the
    // final branch was dead code. Narrow explicitly instead.
    if (level == "error" || level == "warn" || level == "info") {
        pushNotification(message, level)
    } else {
        pushNotification(
            `Unknown notification level ("${level}") for message: ${message}`,
            "error",
        )
    }
}

function handleError(event: ErrorEvent) {
    showNotification(`${event.error}`, "error", event)
}
function handleRejection(event: PromiseRejectionEvent) {
    showNotification(`${event.reason}`, "error", event)
}

window.addEventListener("error", handleError)
window.addEventListener("unhandledrejection", handleRejection)
