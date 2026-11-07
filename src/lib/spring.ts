// A damped spring, described the way Apple's animation APIs describe one:
// `response` is roughly how long a move takes (seconds, the undamped period)
// and `damping` is the damping fraction (1 settles without overshoot, lower
// overshoots and settles). Springs keep their velocity when the target moves
// mid-flight, which is what makes interrupted motion look continuous.

export interface SpringOptions {
    response: number;
    damping: number;
    /** Distance from the target that counts as settled, in the value's own units. */
    precision?: number;
}

export class Spring {
    value: number;
    target: number;
    velocity = 0;
    precision: number;
    private stiffness = 0;
    private friction = 0;

    constructor(value: number, options: SpringOptions) {
        this.value = value;
        this.target = value;
        this.precision = options.precision ?? 0.01;
        this.configure(options);
    }

    configure({ response, damping }: { response: number; damping: number }): void {
        const omega = (2 * Math.PI) / response;
        this.stiffness = omega * omega;
        this.friction = 2 * damping * omega;
    }

    /** Advance by `dt` seconds. Fixed sub-steps keep it stable at any frame rate. */
    step(dt: number): void {
        let remaining = dt;
        while (remaining > 1e-6) {
            const h = Math.min(remaining, 1 / 240);
            const acceleration = -this.stiffness * (this.value - this.target) - this.friction * this.velocity;
            this.velocity += acceleration * h;
            this.value += this.velocity * h;
            remaining -= h;
        }
        if (this.resting) {
            this.value = this.target;
            this.velocity = 0;
        }
    }

    get resting(): boolean {
        return Math.abs(this.value - this.target) < this.precision && Math.abs(this.velocity) < this.precision * 12;
    }

    /** Jump straight to a value, with no motion. */
    snap(value = this.target): void {
        this.value = value;
        this.target = value;
        this.velocity = 0;
    }
}
