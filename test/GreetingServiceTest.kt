package com.example.test

import org.junit.Assert.assertEquals
import org.junit.Test

class GreetingServiceTest {

    private val service = GreetingService()

    @Test
    fun `greet returns correct greeting for valid name`() {
        val result = service.greet("World")
        assertEquals("Hello, World!", result)
    }

    @Test
    fun `greet handles empty string`() {
        val result = service.greet("")
        assertEquals("Hello, !", result)
    }

    @Test
    fun `greet handles null input`() {
        val result = service.greet(null)
        assertEquals("Hello, Guest!", result)
    }

    @Test
    fun `greet trims whitespace from name`() {
        val result = service.greet("  Kotlin  ")
        assertEquals("Hello, Kotlin!", result)
    }

    @Test
    fun `greet handles special characters`() {
        val result = service.greet("Développeur")
        assertEquals("Hello, Développeur!", result)
    }
}
