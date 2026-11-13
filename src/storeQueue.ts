import { AsyncLocalStorage } from "node:async_hooks";

type Work<T> = () => T | Promise<T>;

interface TransactionState {
	failed: boolean;
	error: unknown;
}

interface Scope {
	active: boolean;
	transaction: TransactionState | null;
}

interface TransactionHooks {
	begin: Work<void>;
	commit: Work<void>;
	rollback: Work<void>;
}

/** One connection owner. Expired async scopes cannot bypass admission or serialization. */
export class StoreQueue {
	private readonly context = new AsyncLocalStorage<Scope>();
	private readonly hooks: TransactionHooks;
	private tail: Promise<void> = Promise.resolve();
	private closing: Promise<void> | null = null;
	private accepting = true;
	private broken = false;
	private failure: unknown;

	constructor(hooks: TransactionHooks) {
		this.hooks = hooks;
	}

	run<T>(work: Work<T>): Promise<T> {
		const scope = this.context.getStore();
		if (scope?.active) return this.invoke(work, scope);
		return this.admit(work);
	}

	transaction<T>(work: Work<T>): Promise<T> {
		return this.run(async () => {
			const outer = this.context.getStore();
			if (outer?.transaction) return this.invoke(work, outer);
			const transaction: TransactionState = { failed: false, error: undefined };
			const scope: Scope = { active: true, transaction };
			await this.hooks.begin();
			try {
				const result = await this.context.run(scope, () =>
					this.invoke(work, scope),
				);
				scope.active = false;
				if (transaction.failed) throw transaction.error;
				await this.hooks.commit();
				return result;
			} catch (error) {
				scope.active = false;
				try {
					await this.hooks.rollback();
				} catch (rollbackError) {
					this.broken = true;
					this.failure = rollbackError;
					throw rollbackError;
				}
				throw error;
			} finally {
				scope.active = false;
			}
		});
	}

	close(work: Work<void>): Promise<void> {
		if (this.closing !== null) return this.closing;
		this.accepting = false;
		this.closing = this.tail.then(work);
		return this.closing;
	}

	private admit<T>(work: Work<T>): Promise<T> {
		if (!this.accepting) return Promise.reject(new Error("Store is closed"));
		const result = this.tail.then(async () => {
			if (this.broken) throw this.failure;
			const scope: Scope = { active: true, transaction: null };
			try {
				return await this.context.run(scope, () => this.invoke(work, scope));
			} finally {
				scope.active = false;
			}
		});
		// An application failure must not strand accepted work behind a rejected tail.
		this.tail = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	private async invoke<T>(work: Work<T>, scope: Scope): Promise<T> {
		try {
			return await work();
		} catch (error) {
			if (scope.transaction !== null && !scope.transaction.failed) {
				scope.transaction.failed = true;
				scope.transaction.error = error;
			}
			throw error;
		}
	}
}
