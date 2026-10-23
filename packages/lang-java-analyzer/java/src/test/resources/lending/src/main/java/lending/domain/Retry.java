package lending.domain;

import java.util.concurrent.TimeUnit;

public @interface Retry {
  String value();

  int times() default 1;

  TimeUnit unit() default TimeUnit.MILLISECONDS;

  Class<? extends Throwable> on() default RuntimeException.class;
}
