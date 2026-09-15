import { Component, ComponentEvent } from "../index"
import { getCurrentLanguage, getTranslations } from "../../i18n"
import { ShadcnInputComponent as InputComponent } from "../../ui/shadcn-input"
import { FormModal } from "./form"

export type UserAuth = {
    name: string,
    password: string
}

export class ApiUserPasswordPrompt extends FormModal<UserAuth> {

    private text: HTMLElement = document.createElement("h3")

    private name: InputComponent
    private password: InputComponent
    private passwordFile: InputComponent

    constructor() {
        super()
        const i = getTranslations(getCurrentLanguage()).modal

        this.text.innerText = i.login

        this.name = new InputComponent("ml-api-name", "text", i.username, {
            formRequired: true
        })

        this.password = new InputComponent("ml-api-password", "password", i.password, {
            formRequired: true
        })

        this.passwordFile = new InputComponent("ml-api-password-file", "file", i.passwordAsFile, { accept: ".txt" })
        this.passwordFile.addChangeListener(this.setFilePassword.bind(this))
    }

    // Listener type is widened to ComponentEvent<Component> so the React
    // drop-ins can dispatch it; narrow back to the component we attached to.
    private async setFilePassword(event: ComponentEvent<Component>) {
        const files = (event.component as InputComponent).getFiles()
        if (!files) {
            return
        }

        const file = files[0]
        if (!file) {
            return
        }
        const text = await file.text()

        // Remove carriage return and new line
        const password = text
            .replace(/\r/g, "")
            .replace(/\n/g, "")

        this.password.setValue(password)
    }

    reset(): void {
        this.name.reset()
        this.password.reset()
        this.passwordFile.reset()
    }
    submit(): UserAuth | null {
        const name = this.name.getValue()
        const password = this.password.getValue()

        if (name && password) {
            return { name, password }
        } else {
            return null
        }
    }

    onFinish(abort: AbortSignal): Promise<UserAuth | null> {
        const abortController = new AbortController()
        abort.addEventListener("abort", abortController.abort.bind(abortController))

        return new Promise((resolve, reject) => {
            super.onFinish(abortController.signal).then((data) => {
                abortController.abort()
                resolve(data)
            }, (data) => {
                abortController.abort()
                reject(data)
            })
        })
    }

    mountForm(form: HTMLFormElement): void {
        form.appendChild(this.text)

        this.name.mount(form)

        this.password.mount(form)
        this.passwordFile.mount(form)
    }
}
