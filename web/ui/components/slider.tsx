import * as React from "react"
import * as SliderPrimitive from "@radix-ui/react-slider"

import { cn } from "../lib/cn"

const Slider = React.forwardRef<
    React.ElementRef<typeof SliderPrimitive.Root>,
    React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
    <SliderPrimitive.Root
        ref={ref}
        className={cn(
            "relative flex w-full touch-none select-none items-center",
            "data-[disabled]:opacity-50",
            className,
        )}
        {...props}
    >
        <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-pw-border">
            <SliderPrimitive.Range className="absolute h-full bg-pw-accent" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
            className={cn(
                "block size-4 rounded-full border-2 border-pw-accent bg-pw-bg shadow-sm",
                "transition-colors outline-none focus-visible:ring-2 focus-visible:ring-pw-accent/40",
                "disabled:pointer-events-none",
            )}
        />
    </SliderPrimitive.Root>
))
Slider.displayName = SliderPrimitive.Root.displayName

export { Slider }
