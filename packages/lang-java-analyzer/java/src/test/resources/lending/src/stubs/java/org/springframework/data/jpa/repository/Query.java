package org.springframework.data.jpa.repository;

/** Test stub with the real Spring Data JPA name; no dependency JAR is needed. */
public @interface Query {
  String value() default "";

  String countQuery() default "";

  boolean nativeQuery() default false;

  String name() default "";
}
